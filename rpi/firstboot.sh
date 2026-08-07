#!/usr/bin/env bash
# FoodDesk Raspberry Pi first-boot provisioning. Run once by
# fooddesk-firstboot.service (a failed run retries on the next boot).
#
# - applies venue overrides from fooddesk.txt on the boot partition
# - unblocks Wi-Fi and brings the access point up
# - creates the database and the admin account with a generated password
# - writes all credentials to fooddesk-info.txt on the boot partition, so
#   the installer can read them from any laptop by re-inserting the SD card
set -uo pipefail

BOOT=/boot/firmware
CONF="$BOOT/fooddesk.txt"
INFO="$BOOT/fooddesk-info.txt"
ENV_FILE=/etc/fooddesk/env
APP=/opt/fooddesk

log() { echo "fooddesk-firstboot: $*"; }

# ---- defaults, overridable from fooddesk.txt (KEY=VALUE, one per line) ----
WIFI_SSID='FoodDesk'
WIFI_PASSWORD='fooddesk-wifi'
WIFI_COUNTRY='IT'
RESTAURANT_NAME=''
PDF_LANG=''
ADMIN_PASSWORD=''
KIOSK=''

if [ -f "$CONF" ]; then
  log "applying $CONF"
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
if [ -n "$RESTAURANT_NAME" ]; then
  sed -i "s|^RESTAURANT_NAME=.*|RESTAURANT_NAME=$RESTAURANT_NAME|" "$ENV_FILE"
fi
if [ -n "$PDF_LANG" ]; then
  sed -i "s|^PDF_LANG=.*|PDF_LANG=$PDF_LANG|" "$ENV_FILE"
fi

# ---- database + admin account ----
if [ -z "$ADMIN_PASSWORD" ]; then
  ADMIN_PASSWORD="$(tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"
fi
set -a; . "$ENV_FILE"; set +a
sudo -u fooddesk env "DATABASE_FILE=$DATABASE_FILE" \
  node "$APP/server/dist/db/migrate.js" || { log "migrate failed"; exit 1; }
sudo -u fooddesk env "DATABASE_FILE=$DATABASE_FILE" \
  ADMIN_USERNAME=admin "ADMIN_PASSWORD=$ADMIN_PASSWORD" \
  node "$APP/server/dist/db/seed.js" || { log "seed failed"; exit 1; }
systemctl restart fooddesk.service || true

# ---- kiosk mode: the attached screen becomes the kitchen display ----
if [ "$KIOSK" = "kitchen" ]; then
  KIOSK_USER="$(sudo -u fooddesk env "DATABASE_FILE=$DATABASE_FILE" \
    node "$APP/rpi/create-kitchen-user.mjs")" || KIOSK_USER=''
  if [ -n "$KIOSK_USER" ]; then
    if grep -q '^#\?KIOSK_AUTOLOGIN_USER=' "$ENV_FILE"; then
      sed -i "s|^#\?KIOSK_AUTOLOGIN_USER=.*|KIOSK_AUTOLOGIN_USER=$KIOSK_USER|" "$ENV_FILE"
    else
      echo "KIOSK_AUTOLOGIN_USER=$KIOSK_USER" >> "$ENV_FILE"
    fi
    systemctl restart fooddesk.service || true
    systemctl enable fooddesk-kiosk.service || true
    systemctl start --no-block fooddesk-kiosk.service || true
    log "kiosk mode on — the attached screen shows the kitchen display (user: $KIOSK_USER)"
  else
    log "kiosk requested but the kitchen account could not be created"
  fi
fi

# ---- hand the credentials to the installer ----
umask 077
cat > "$INFO" <<INFO
FoodDesk — this device is ready.

Wi-Fi network:   $WIFI_SSID
Wi-Fi password:  $WIFI_PASSWORD

Open in the browser:  http://10.42.0.1/  (or http://fooddesk.local/)

App login:       admin
App password:    $ADMIN_PASSWORD

Change the admin password after the first login (tap your name, top right).
To reconfigure, edit fooddesk.txt on this SD card partition, delete
/etc/fooddesk/.initialized on the Pi, and reboot.

Provisioned: $(date -u '+%Y-%m-%d %H:%M UTC')
INFO

cat >> /etc/issue <<ISSUE

FoodDesk pronto / ready — Wi-Fi "$WIFI_SSID" → http://10.42.0.1/
Credenziali / credentials: fooddesk-info.txt (SD card, boot partition)

ISSUE

# ---- printable leaflet with the Wi-Fi QR (no admin credentials on it) ----
node "$APP/rpi/leaflet.mjs" --ssid "$WIFI_SSID" --password "$WIFI_PASSWORD" \
  --out "$BOOT/fooddesk-leaflet.pdf" || log "leaflet generation failed (non-fatal)"

log "provisioning complete — credentials in $INFO"
