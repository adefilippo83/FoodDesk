#!/usr/bin/env bash
# Updates FoodDesk on the appliance from a GitHub release. Needs an internet
# uplink (Ethernet or tethering). Installed as /usr/local/bin/fooddesk-update.
#
#   fooddesk-update                # update to the latest release
#   fooddesk-update v1.2.3        # update to a specific release
#   fooddesk-update --rollback    # swap back to the previous version
#
# The database is untouched (and snapshotted first); the previous install is
# kept at /opt/fooddesk.prev and restored automatically if the updated
# server fails its health check.
set -euo pipefail

APP=/opt/fooddesk
REPO=adefilippo83/FoodDesk
ENV_FILE=/etc/fooddesk/env
STAGING=/opt/fooddesk.new

[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo fooddesk-update"; exit 1; }

health_ok() {
  for i in $(seq 1 30); do
    curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# Read one key from the EnvironmentFile without sourcing it. `. "$ENV_FILE"`
# under `set -e` aborts the whole update if any value has an unquoted space
# (older appliances wrote RESTAURANT_NAME=Sagra del Borgo); this parser strips
# optional surrounding quotes and never executes the value.
read_env() {
  line=$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1) || return 0
  val=${line#*=}
  val=${val#[\"\']}
  val=${val%[\"\']}
  printf '%s' "$val"
}

if [ "${1:-}" = "--rollback" ]; then
  [ -d "$APP.prev" ] || { echo "no previous version at $APP.prev"; exit 1; }
  echo "== rolling back =="
  systemctl stop fooddesk.service
  mv "$APP" "$APP.rolledback"
  mv "$APP.prev" "$APP"
  mv "$APP.rolledback" "$APP.prev"
  systemctl start fooddesk.service
  health_ok && echo "rollback complete" || echo "WARNING: server not healthy after rollback"
  exit 0
fi

TAG="${1:-}"
if [ -z "$TAG" ]; then
  TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -m1 '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  [ -n "$TAG" ] || { echo "could not resolve the latest release (no internet?)"; exit 1; }
fi

CURRENT="$(node -p "require('$APP/server/package.json').version" 2>/dev/null || echo unknown)"
echo "installed: v$CURRENT — target: $TAG"
if [ "v$CURRENT" = "$TAG" ]; then
  echo "already up to date"
  exit 0
fi

echo "== downloading $TAG =="
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$STAGING"' EXIT
curl -fSL -o "$TMP/fooddesk.tar.gz" \
  "https://github.com/$REPO/releases/download/$TAG/fooddesk-$TAG.tar.gz"

echo "== staging =="
rm -rf "$STAGING"
mkdir -p "$STAGING"
tar -xzf "$TMP/fooddesk.tar.gz" -C "$STAGING"
[ -f "$STAGING/server/dist/index.js" ] || { echo "tarball has no prebuilt server"; exit 1; }
# Releases older than the rpi kit lack rpi/ — keep the running scripts, since
# the installed systemd units point into $APP/rpi.
[ -d "$STAGING/rpi" ] || cp -a "$APP/rpi" "$STAGING/rpi"

echo "== installing dependencies (arm64) =="
(cd "$STAGING" && npm ci --omit=dev && npm cache clean --force)

echo "== snapshot before switching =="
DB="$(read_env DATABASE_FILE)"; DB="${DB:-/var/lib/fooddesk/fooddesk.db}"
export DATABASE_FILE="$DB"
BACKUP_DIR_VAL="$(read_env BACKUP_DIR)"; [ -n "$BACKUP_DIR_VAL" ] && export BACKUP_DIR="$BACKUP_DIR_VAL"
# A dedicated pre-update snapshot at a known path: the new version migrates the
# schema at boot, so if we later roll back the CODE the OLD binary may not read
# the migrated DB — this snapshot is what makes the rollback actually recover.
PRE_SNAPSHOT="$APP.pre-$TAG.db"
if [ -f "$DB" ]; then
  sqlite3 "$DB" ".backup '$PRE_SNAPSHOT'" || { echo "warning: pre-update DB snapshot failed"; PRE_SNAPSHOT=''; }
else
  PRE_SNAPSHOT=''
fi
"$APP/deploy/fooddesk-backup.sh" || echo "warning: pre-update backup failed"

echo "== switching =="
systemctl stop fooddesk.service
rm -rf "$APP.prev"
mv "$APP" "$APP.prev"
mv "$STAGING" "$APP"
chmod +x "$APP"/rpi/*.sh "$APP/deploy/fooddesk-backup.sh" 2>/dev/null || true
systemctl start fooddesk.service

if health_ok; then
  echo "updated to $TAG — previous version kept at $APP.prev (fooddesk-update --rollback)"
  [ -n "$PRE_SNAPSHOT" ] && rm -f "$PRE_SNAPSHOT"
else
  echo "health check FAILED — rolling back automatically"
  systemctl stop fooddesk.service
  mv "$APP" "$APP.failed-$TAG"
  mv "$APP.prev" "$APP"
  systemctl start fooddesk.service
  if health_ok; then
    echo "rolled back to the previous version; the failed tree is at $APP.failed-$TAG"
    exit 1
  fi
  # The old code is unhealthy too — almost always because the new version
  # already migrated the database forward and the old binary cannot read it.
  # Restore the pre-update snapshot and try once more before giving up.
  echo "rollback still unhealthy — restoring the pre-update database snapshot"
  if [ -n "$PRE_SNAPSHOT" ] && [ -f "$PRE_SNAPSHOT" ]; then
    systemctl stop fooddesk.service
    rm -f "$DB" "$DB-wal" "$DB-shm"
    cp "$PRE_SNAPSHOT" "$DB"
    chown fooddesk:fooddesk "$DB" 2>/dev/null || true
    systemctl start fooddesk.service
    if health_ok; then
      echo "restored the pre-update database; the appliance is back up (failed tree at $APP.failed-$TAG)"
      exit 1
    fi
  fi
  echo "CRITICAL: the appliance is DOWN after rollback. Restore a backup from ${BACKUP_DIR_VAL:-/var/backups/fooddesk} and reboot."
  exit 1
fi
