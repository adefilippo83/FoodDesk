#!/usr/bin/env bash
# FoodDesk installer/updater for Debian. Run as root from a checkout:
#   sudo deploy/install.sh
# Idempotent: run it again to deploy an update — data and config are kept.
set -euo pipefail

APP_DIR=/opt/fooddesk
DATA_DIR=/var/lib/fooddesk
ENV_FILE=/etc/fooddesk/env
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo deploy/install.sh"; exit 1; }

command -v node >/dev/null || {
  echo "node not found. Install Node 24 LTS first:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs"
  exit 1
}
command -v sqlite3 >/dev/null || apt-get install -y sqlite3
command -v rsync >/dev/null || apt-get install -y rsync

echo "== system user =="
id fooddesk >/dev/null 2>&1 || adduser --system --group --home "$DATA_DIR" --no-create-home fooddesk

echo "== copy source to $APP_DIR =="
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude 'server/data' \
  --exclude 'server/dist' --exclude 'server/public' \
  "$SRC_DIR/" "$APP_DIR/"

echo "== build =="
cd "$APP_DIR"
npm ci
npm run build
npm prune --omit=dev

echo "== directories and config =="
mkdir -p "$DATA_DIR" /var/backups/fooddesk /etc/fooddesk
chown fooddesk:fooddesk "$DATA_DIR"
if [ ! -f "$ENV_FILE" ]; then
  cp "$APP_DIR/deploy/env.example" "$ENV_FILE"
  # Without nginx the app itself must listen on the LAN.
  command -v nginx >/dev/null || sed -i 's/^HOST=127.0.0.1/HOST=0.0.0.0/' "$ENV_FILE"
  echo "wrote $ENV_FILE — edit it to set KITCHEN_PRINTER and RESTAURANT_NAME"
fi

echo "== seed admin account (first run only) =="
set -a; . "$ENV_FILE"; set +a
sudo -u fooddesk --preserve-env=DATABASE_FILE,ADMIN_USERNAME,ADMIN_PASSWORD \
  node "$APP_DIR/server/dist/db/seed.js"

echo "== systemd =="
chmod +x "$APP_DIR/deploy/fooddesk-backup.sh"
cp "$APP_DIR/deploy/fooddesk.service" /etc/systemd/system/
cp "$APP_DIR/deploy/fooddesk-backup.service" /etc/systemd/system/
cp "$APP_DIR/deploy/fooddesk-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fooddesk.service fooddesk-backup.timer
systemctl restart fooddesk.service

if command -v nginx >/dev/null; then
  echo "== nginx =="
  cp "$APP_DIR/deploy/nginx-fooddesk.conf" /etc/nginx/sites-available/fooddesk
  ln -sf /etc/nginx/sites-available/fooddesk /etc/nginx/sites-enabled/fooddesk
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
fi

echo
echo "Done. Status:"
systemctl --no-pager --lines 3 status fooddesk.service || true
ip=$(hostname -I 2>/dev/null | awk '{print $1}')
if command -v nginx >/dev/null; then
  echo "Open: http://${ip:-<server-ip>}/"
else
  echo "Open: http://${ip:-<server-ip>}:${PORT:-3000}/"
fi
