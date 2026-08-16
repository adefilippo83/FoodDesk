#!/usr/bin/env bash
# FoodDesk Raspberry Pi provisioning. Runs at every boot via
# fooddesk-provision.service, but acts only when fooddesk.txt on the boot
# partition changed (or on the very first boot) — so "edit the file on any
# laptop, put the SD card back, power on" is the whole reconfiguration story.
#
# First boot:  full provisioning — Wi-Fi AP, app config, database, admin
#              account with a generated password, credentials + leaflet
#              written to the boot partition.
# Re-apply:    same, minus the admin account: the password is only touched
#              when ADMIN_PASSWORD is explicitly set in fooddesk.txt (which
#              is also the recovery path for a lost password).
#
# Markers are written only on success, so a failed run retries next boot.
set -uo pipefail

BOOT=/boot/firmware
CONF="$BOOT/fooddesk.txt"
INFO="$BOOT/fooddesk-info.txt"
ENV_FILE=/etc/fooddesk/env
APP=/opt/fooddesk
MARKER=/etc/fooddesk/.provisioned
APPLIED=/etc/fooddesk/.applied-config

log() { echo "fooddesk-provision: $*"; }

# ---- fast path: provisioned and the config file is unchanged ----
if [ -f "$CONF" ]; then
  CONF_HASH="$(sha256sum "$CONF" | cut -d' ' -f1)"
else
  CONF_HASH=none
fi
if [ -f "$MARKER" ] && [ "$(cat "$APPLIED" 2>/dev/null)" = "$CONF_HASH" ]; then
  exit 0
fi
FIRST_RUN=yes
[ -f "$MARKER" ] && FIRST_RUN=no
log "applying configuration (first run: $FIRST_RUN)"

# ---- defaults, overridable from fooddesk.txt (KEY=VALUE, one per line) ----
WIFI_SSID='FoodDesk'
WIFI_PASSWORD='fooddesk-wifi'
WIFI_COUNTRY='IT'
RESTAURANT_NAME=''
PDF_LANG=''
ADMIN_PASSWORD=''
KIOSK=''

if [ -f "$CONF" ]; then
  # tr strips Windows line endings — the file is usually edited on a laptop.
  while IFS='=' read -r key value; do
    value="$(printf '%s' "$value" | tr -d '\r')"
    case "$key" in
      WIFI_SSID) [ -n "$value" ] && WIFI_SSID="$value" ;;
      WIFI_PASSWORD) [ -n "$value" ] && WIFI_PASSWORD="$value" ;;
      WIFI_COUNTRY) [ -n "$value" ] && WIFI_COUNTRY="$value" ;;
      RESTAURANT_NAME) RESTAURANT_NAME="$value" ;;
      PDF_LANG) PDF_LANG="$value" ;;
      ADMIN_PASSWORD) ADMIN_PASSWORD="$value" ;;
      KIOSK) KIOSK="$value" ;;
    esac
  done < "$CONF"
fi

if [ "${#WIFI_PASSWORD}" -lt 8 ]; then
  log "WIFI_PASSWORD shorter than 8 characters (WPA2 minimum) — keeping default"
  WIFI_PASSWORD='fooddesk-wifi'
fi

# ---- Wi-Fi access point ----
raspi-config nonint do_wifi_country "$WIFI_COUNTRY" || log "wifi country failed (non-fatal)"
rfkill unblock wifi || true

# NetworkManager may still be starting; retry briefly.
for i in $(seq 1 15); do
  if nmcli -t connection show fooddesk-ap >/dev/null 2>&1; then break; fi
  sleep 2
done
nmcli connection modify fooddesk-ap \
  802-11-wireless.ssid "$WIFI_SSID" \
  802-11-wireless-security.psk "$WIFI_PASSWORD" \
  || log "could not update AP profile (non-fatal)"
nmcli connection up fooddesk-ap || log "AP not up yet — it will start on the next boot"

# ---- app configuration ----
# Write values SINGLE-QUOTED. Both a shell `. env` (used by the updater and
# backup scripts) and systemd's EnvironmentFile accept single-quoted values and
# strip the quotes; without quoting, a value with a space like "Sagra del Borgo"
# makes a sourcing script run "del Borgo" as a command and abort. printf (not
# sed) writes the value so & | and friends are never re-interpreted.
set_env() {
  key="$1"
  esc=$(printf '%s' "$2" | sed "s/'/'\\\\''/g")
  sed -i "/^#\\?${key}=/d" "$ENV_FILE"
  # A hand-edited file may lack its final newline; appending blind would then
  # glue our assignment onto the previous line.
  if [ -s "$ENV_FILE" ] && [ -n "$(tail -c1 "$ENV_FILE")" ]; then
    printf '\n' >> "$ENV_FILE"
  fi
  printf "%s='%s'\n" "$key" "$esc" >> "$ENV_FILE"
}
if [ -n "$RESTAURANT_NAME" ]; then set_env RESTAURANT_NAME "$RESTAURANT_NAME"; fi
if [ -n "$PDF_LANG" ]; then set_env PDF_LANG "$PDF_LANG"; fi

# ---- database + admin account ----
# First boot: create everything, generating a password if none was given.
# Re-apply: leave the admin alone unless ADMIN_PASSWORD is explicitly set —
# a config edit must never lock the admin out with a fresh random password.
set -a; . "$ENV_FILE"; set +a
ADMIN_NOTE='(unchanged)'
if [ "$FIRST_RUN" = yes ] && [ -z "$ADMIN_PASSWORD" ]; then
  ADMIN_PASSWORD="$(tr -dc 'a-z0-9' 2>/dev/null < /dev/urandom | head -c 12)"
fi
if [ -n "$ADMIN_PASSWORD" ]; then
  runuser -u fooddesk -- env "DATABASE_FILE=$DATABASE_FILE" \
    node "$APP/server/dist/db/migrate.js" || { log "migrate failed"; exit 1; }
  runuser -u fooddesk -- env "DATABASE_FILE=$DATABASE_FILE" \
    ADMIN_USERNAME=admin "ADMIN_PASSWORD=$ADMIN_PASSWORD" \
    node "$APP/server/dist/db/seed.js" || { log "seed failed"; exit 1; }
  ADMIN_NOTE="$ADMIN_PASSWORD"
fi
systemctl restart --no-block fooddesk.service || true

# ---- maintenance OS account (SSH / CUPS) password ----
# Per-device random password, set on first boot only. Never a fixed default:
# the account is shipped LOCKED (rpi/setup.sh) precisely so there is no
# known-password window on the shared venue Wi-Fi. Written to fooddesk-info.txt.
OS_ADMIN_NOTE='(unchanged)'
if [ "$FIRST_RUN" = yes ] && id fooddesk-admin >/dev/null 2>&1; then
  OS_ADMIN_PW="$(tr -dc 'a-z0-9' 2>/dev/null < /dev/urandom | head -c 14)"
  echo "fooddesk-admin:$OS_ADMIN_PW" | chpasswd
  chage -d 0 fooddesk-admin   # force a change on the first interactive login
  OS_ADMIN_NOTE="$OS_ADMIN_PW"
fi

# ---- kiosk mode: the attached screen becomes the kitchen display ----
if [ "$KIOSK" = "kitchen" ]; then
  KIOSK_USER="$(runuser -u fooddesk -- env "DATABASE_FILE=$DATABASE_FILE" \
    node "$APP/rpi/create-kitchen-user.mjs")" || KIOSK_USER=''
  if [ -n "$KIOSK_USER" ]; then
    if grep -q '^#\?KIOSK_AUTOLOGIN_USER=' "$ENV_FILE"; then
      sed -i "s|^#\?KIOSK_AUTOLOGIN_USER=.*|KIOSK_AUTOLOGIN_USER=$KIOSK_USER|" "$ENV_FILE"
    else
      echo "KIOSK_AUTOLOGIN_USER=$KIOSK_USER" >> "$ENV_FILE"
    fi
    systemctl restart --no-block fooddesk.service || true
    systemctl enable fooddesk-kiosk.service || true
    systemctl start --no-block fooddesk-kiosk.service || true
    log "kiosk mode on — the attached screen shows the kitchen display (user: $KIOSK_USER)"
  else
    log "kiosk requested but the kitchen account could not be created"
  fi
elif systemctl is-enabled fooddesk-kiosk.service >/dev/null 2>&1; then
  systemctl disable --now fooddesk-kiosk.service || true
  sed -i 's|^KIOSK_AUTOLOGIN_USER=.*|#KIOSK_AUTOLOGIN_USER=|' "$ENV_FILE"
  systemctl restart --no-block fooddesk.service || true
  log "kiosk mode off"
fi

# ---- hand the credentials to the installer ----
umask 077
cat > "$INFO" <<INFO
FoodDesk — this device is ready.

Wi-Fi network:   $WIFI_SSID
Wi-Fi password:  $WIFI_PASSWORD

Open in the browser:  http://10.42.0.1/  (or http://fooddesk.local/)

App login:       admin
App password:    $ADMIN_NOTE

SSH / maintenance (user fooddesk-admin):  $OS_ADMIN_NOTE
  — a per-device password; you are prompted to change it on first SSH login.

Change the admin password after the first login (tap your name, top right).
To reconfigure: edit fooddesk.txt on this SD card partition (or over SSH)
and reboot — changes apply automatically. Lost the app password? Set
ADMIN_PASSWORD=... in fooddesk.txt, reboot, then remove the line.

Provisioned: $(date -u '+%Y-%m-%d %H:%M UTC')
INFO

grep -q 'FoodDesk pronto' /etc/issue 2>/dev/null || cat >> /etc/issue <<ISSUE

FoodDesk pronto / ready — Wi-Fi "$WIFI_SSID" → http://10.42.0.1/
Credenziali / credentials: fooddesk-info.txt (SD card, boot partition)

ISSUE

# ---- printable leaflet with the Wi-Fi QR (no admin credentials on it) ----
node "$APP/rpi/leaflet.mjs" --ssid "$WIFI_SSID" --password "$WIFI_PASSWORD" \
  --out "$BOOT/fooddesk-leaflet.pdf" || log "leaflet generation failed (non-fatal)"

# Success markers last: a failed run above retries on the next boot.
echo "$CONF_HASH" > "$APPLIED"
touch "$MARKER"
log "configuration applied — credentials in $INFO"
