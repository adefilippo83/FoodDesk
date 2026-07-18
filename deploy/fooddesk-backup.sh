#!/usr/bin/env bash
# Online backup of the FoodDesk database. Safe to run while the server is
# serving orders: sqlite3 .backup takes a consistent snapshot even mid-write,
# which a plain cp of a WAL database does not.
set -euo pipefail

DB="${DATABASE_FILE:-/var/lib/fooddesk/fooddesk.db}"
DEST_DIR="${BACKUP_DIR:-/var/backups/fooddesk}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

[ -f "$DB" ] || { echo "no database at $DB, nothing to back up"; exit 0; }
mkdir -p "$DEST_DIR"

stamp="$(date +%Y-%m-%d_%H%M)"
dest="$DEST_DIR/fooddesk-$stamp.db"

sqlite3 "$DB" ".backup '$dest'"
gzip -f "$dest"

# Prune old snapshots so a season of 15-minute backups cannot fill the disk.
find "$DEST_DIR" -name 'fooddesk-*.db.gz' -mtime "+$KEEP_DAYS" -delete

echo "backup written: $dest.gz"
