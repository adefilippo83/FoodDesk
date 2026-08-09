#!/usr/bin/env bash
# Turns a stock Raspberry Pi OS Lite (arm64, Trixie) into the FoodDesk
# appliance. Runs inside the image chroot via pguyot/arm-runner-action
# (.github/workflows/rpi-image.yml), with the repository as the working
# directory and server/dist + server/public already built on the runner.
#
# The result boots as a self-contained venue box: FoodDesk behind nginx on
# port 80, a "FoodDesk" Wi-Fi access point with DHCP/DNS, 15-minute database
# backups, and a first-boot service that seeds the admin account and writes
# the credentials to the SD card's boot partition.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
SRC="$(pwd)"
APP=/opt/fooddesk

echo "== packages =="
apt-get update
# make/g++/python3 are the node-gyp fallback in case a native module has no
# prebuilt arm64 binary; better-sqlite3 normally ships one.
# dnsmasq-base and wpasupplicant are what NetworkManager's shared-mode AP
# actually runs on — they are only Recommends of the NM package, so pin
# them rather than trust the base image.
apt-get install -y --no-install-recommends \
  nginx-light sqlite3 avahi-daemon rfkill \
  dnsmasq-base wpasupplicant \
  cups cups-client ipp-usb \
  cage chromium fonts-liberation \
  ca-certificates curl xz-utils make g++ python3

echo "== node 24 (official arm64 build) =="
NODE_TARBALL=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/ \
  | grep -o 'node-v24[0-9.]*-linux-arm64\.tar\.xz' | head -1)
[ -n "$NODE_TARBALL" ] || { echo "could not resolve Node 24 tarball"; exit 1; }
curl -fsSL "https://nodejs.org/dist/latest-v24.x/$NODE_TARBALL" \
  | tar -xJ -C /usr/local --strip-components=1
node -v
# systemd ExecStart= paths and sudo's secure_path don't include
# /usr/local/bin — the service unit and the provisioning sudo calls need
# node reachable at /usr/bin.
ln -sf /usr/local/bin/node /usr/bin/node
ln -sf /usr/local/bin/npm /usr/bin/npm
ln -sf /usr/local/bin/npx /usr/bin/npx

echo "== app install to $APP =="
id fooddesk >/dev/null 2>&1 \
  || adduser --system --group --home /var/lib/fooddesk --no-create-home fooddesk
mkdir -p "$APP/server" "$APP/web" "$APP/rpi" /var/lib/fooddesk /var/backups/fooddesk /etc/fooddesk
cp "$SRC/package.json" "$SRC/package-lock.json" "$APP/"
cp -a "$SRC/server/package.json" "$SRC/server/dist" "$SRC/server/public" "$SRC/server/drizzle" "$APP/server/"
cp "$SRC/web/package.json" "$APP/web/"
cp -a "$SRC/deploy" "$APP/deploy"
cp "$SRC/rpi/provision.sh" "$SRC/rpi/printer-hotplug.sh" "$SRC/rpi/usb-backup.sh" \
  "$SRC/rpi/leaflet.mjs" "$SRC/rpi/create-kitchen-user.mjs" "$APP/rpi/"
chmod +x "$APP/rpi/provision.sh" "$APP/rpi/printer-hotplug.sh" "$APP/rpi/usb-backup.sh" \
  "$APP/deploy/fooddesk-backup.sh"
install -m 755 "$SRC/rpi/fooddesk-update.sh" /usr/local/bin/fooddesk-update
chown fooddesk:fooddesk /var/lib/fooddesk

cd "$APP"
npm ci --omit=dev
npm cache clean --force

echo "== app config + services =="
cp "$APP/deploy/env.example" /etc/fooddesk/env
cp "$APP/deploy/fooddesk.service" /etc/systemd/system/
cp "$APP/deploy/fooddesk-backup.service" /etc/systemd/system/
cp "$APP/deploy/fooddesk-backup.timer" /etc/systemd/system/
cp "$SRC/rpi/fooddesk-provision.service" /etc/systemd/system/
cp "$SRC/rpi/fooddesk-printer-setup.service" /etc/systemd/system/
cp "$SRC/rpi/fooddesk-usb-backup@.service" /etc/systemd/system/
cp "$SRC/rpi/fooddesk-usb-backup.service" /etc/systemd/system/
cp "$SRC/rpi/fooddesk-usb-backup.timer" /etc/systemd/system/
cp "$SRC/rpi/fooddesk-kiosk.service" /etc/systemd/system/
# On a true first boot (empty machine-id) systemd runs preset-all, and the
# Debian default preset enables everything — which would switch the kiosk
# on for every device. Declare our policy explicitly.
mkdir -p /etc/systemd/system-preset
cat > /etc/systemd/system-preset/50-fooddesk.preset <<'EOF'
enable fooddesk.service
enable fooddesk-provision.service
enable fooddesk-backup.timer
enable fooddesk-usb-backup.timer
disable fooddesk-kiosk.service
disable fooddesk-backup.service
disable fooddesk-usb-backup.service
disable fooddesk-usb-backup@.service
disable fooddesk-printer-setup.service
EOF
systemctl enable fooddesk.service fooddesk-backup.timer fooddesk-provision.service \
  fooddesk-usb-backup.timer cups ssh

echo "== printing (CUPS + USB hotplug) =="
cp "$SRC/rpi/cupsd.conf" /etc/cups/cupsd.conf
cp "$SRC/rpi/99-fooddesk-printer.rules" /etc/udev/rules.d/99-fooddesk-printer.rules

echo "== USB stick backups =="
cp "$SRC/rpi/99-fooddesk-usb-backup.rules" /etc/udev/rules.d/99-fooddesk-usb-backup.rules

echo "== nginx =="
cp "$APP/deploy/nginx-fooddesk.conf" /etc/nginx/sites-available/fooddesk
# Connectivity-check spoofing (offline venues): well-known probe paths must
# be answered inside the default server too, or the SPA fallback would feed
# index.html to Android's 204 probe and trigger captive-portal mode.
mkdir -p /etc/nginx/snippets
cp "$SRC/rpi/nginx-probes-snippet.conf" /etc/nginx/snippets/fooddesk-probes.conf
cp "$SRC/rpi/nginx-probes-site.conf" /etc/nginx/sites-available/fooddesk-probes
sed -i '/server_name _;/a\    include snippets/fooddesk-probes.conf;' \
  /etc/nginx/sites-available/fooddesk
grep -q 'fooddesk-probes' /etc/nginx/sites-available/fooddesk \
  || { echo "probe snippet include not inserted"; exit 1; }
ln -sf /etc/nginx/sites-available/fooddesk /etc/nginx/sites-enabled/fooddesk
ln -sf /etc/nginx/sites-available/fooddesk-probes /etc/nginx/sites-enabled/fooddesk-probes
rm -f /etc/nginx/sites-enabled/default
nginx -t

echo "== hostname (fooddesk.local via avahi) =="
echo fooddesk > /etc/hostname
sed -i 's/^127\.0\.1\.1.*/127.0.1.1\tfooddesk/' /etc/hosts
grep -q '^127\.0\.1\.1' /etc/hosts || echo -e '127.0.1.1\tfooddesk' >> /etc/hosts

echo "== Wi-Fi access point =="
install -m 600 "$SRC/rpi/fooddesk-ap.nmconnection" \
  /etc/NetworkManager/system-connections/fooddesk-ap.nmconnection
# Offline-first DNS: every hostname resolves to the Pi (so any URL opens
# FoodDesk and the nginx probe spoofs keep devices happy), with Windows'
# NCSI DNS probe answered specifically. The dispatcher hook flips this file
# to normal forwarding whenever a real uplink appears.
mkdir -p /etc/NetworkManager/dnsmasq-shared.d
cat > /etc/NetworkManager/dnsmasq-shared.d/fooddesk.conf <<'EOF'
# fooddesk (auto): no uplink — captive-style DNS, all names lead to the Pi.
address=/dns.msftncsi.com/131.107.255.255
address=/#/10.42.0.1
EOF
install -m 755 "$SRC/rpi/90-fooddesk-ap-dns" \
  /etc/NetworkManager/dispatcher.d/90-fooddesk-ap-dns

echo "== boot partition config template =="
# Editable from any laptop, applied by rpi/provision.sh at the next boot.
# On a running Pi the FAT boot partition sits at /boot/firmware; inside the
# arm-runner chroot it is mounted at /boot (hiding the rootfs' firmware
# directory), so fall back accordingly.
BOOTFS=/boot/firmware
[ -d "$BOOTFS" ] || BOOTFS=/boot
cat > "$BOOTFS/fooddesk.txt" <<'TXT'
# FoodDesk configuration. Edit this file any time — from a laptop with the
# SD card, or over SSH — and reboot: changes are applied automatically.
# Lines starting with # are ignored. The generated credentials appear in
# fooddesk-info.txt next to this file after the first boot.

# Wi-Fi network the venue devices will join (password: 8+ characters).
WIFI_SSID=FoodDesk
WIFI_PASSWORD=fooddesk-wifi

# Two-letter Wi-Fi country code (regulatory domain).
WIFI_COUNTRY=IT

# Shown on receipts; can also be changed later in Settings.
#RESTAURANT_NAME=Sagra del Borgo

# Language of printed documents: it, en, es, fr, pt.
#PDF_LANG=it

# Leave commented: a random admin password is generated on the first boot
# (recommended). Setting a value here (re)sets the admin password at the
# next boot — that is also the recovery for a lost password; remove the
# line afterwards.
#ADMIN_PASSWORD=

# Attach an HDMI touchscreen and set "kitchen" to boot straight into the
# kitchen display; set "off" to turn the kiosk back off.
#KIOSK=kitchen
TXT

echo "== power-loss hardening =="
# Festivals cut power without warning. Fewer SD writes = fewer corruption
# windows and less card wear: logs live in RAM, no swapfile, no background
# apt/man-db churn. The database itself is WAL SQLite (torn-write safe) and
# is snapshotted every 15 minutes.
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/fooddesk.conf <<'EOF'
[Journal]
Storage=volatile
RuntimeMaxUse=64M
EOF
systemctl disable dphys-swapfile 2>/dev/null || true
systemctl disable apt-daily.timer apt-daily-upgrade.timer man-db.timer 2>/dev/null || true

echo "== hardware watchdog =="
# The BCM watchdog reboots a wedged box mid-service; systemd pets it.
mkdir -p /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/fooddesk-watchdog.conf <<'EOF'
[Manager]
RuntimeWatchdogSec=15
RebootWatchdogSec=2min
EOF
BOOTCFG=/boot/firmware/config.txt
[ -f "$BOOTCFG" ] || BOOTCFG=/boot/config.txt
grep -q '^dtparam=watchdog=on' "$BOOTCFG" || echo 'dtparam=watchdog=on' >> "$BOOTCFG"

echo "== kiosk user =="
# Runs the cage/Chromium kitchen display when KIOSK=kitchen is set; the
# service stays disabled otherwise. No shell, no sudo — display groups only.
id kiosk >/dev/null 2>&1 \
  || useradd -m -s /usr/sbin/nologin -G video,render,input kiosk

echo "== maintenance login =="
# A real (uid 1000) user also stops Raspberry Pi OS's first-boot user wizard.
if ! id fooddesk-admin >/dev/null 2>&1; then
  # lpadmin: the same account authenticates on the CUPS web interface.
  useradd -m -s /bin/bash -G sudo,lpadmin fooddesk-admin
  echo 'fooddesk-admin:fooddesk' | chpasswd
  chage -d 0 fooddesk-admin   # force a password change on first login
fi

echo "== smoke checks =="
test -f "$APP/server/dist/index.js"
test -f "$APP/server/dist/db/seed.js"
test -f "$APP/server/dist/db/migrate.js"
test -f "$APP/server/public/index.html"
test -d "$APP/server/drizzle"
test -x /usr/bin/node
node -e "import('better-sqlite3').then(() => console.log('better-sqlite3: arm64 module loads'))"
node -e "import('$APP/server/dist/app.js').then(() => console.log('server bundle: imports cleanly'))"
node "$APP/rpi/leaflet.mjs" --ssid smoke --password smoketest --out /tmp/leaflet-smoke.pdf
head -c 5 /tmp/leaflet-smoke.pdf | grep -q '%PDF-' && rm /tmp/leaflet-smoke.pdf
command -v driverless >/dev/null || { echo "driverless tool missing"; exit 1; }

echo "== cleanup =="
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.npm

echo "rpi/setup.sh: done"
