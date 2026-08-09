#!/usr/bin/env bash
# USB-stick backup mirror for the FoodDesk appliance.
#
#   usb-backup.sh attach <partition>   udev: a USB partition appeared
#   usb-backup.sh periodic             timer: every 15 min while a stick is in
#
# Plug any USB stick in and it gains a fooddesk-backups/ directory that
# receives the existing snapshot history plus a fresh consistent snapshot,
# then stays mirrored every 15 minutes. Nothing outside that directory is
# ever touched. vfat/exfat mounts use sync+flush so yanking the stick
# without unmounting is as safe as it can be made.
set -uo pipefail

MNT=/media/fooddesk-backup
ENV_FILE=/etc/fooddesk/env
BACKUP_SCRIPT=/opt/fooddesk/deploy/fooddesk-backup.sh

log() { logger -t fooddesk-usb-backup "$*"; echo "$*"; }

snapshot_to_stick() {
  set -a; . "$ENV_FILE"; set +a
  mkdir -p "$MNT/fooddesk-backups"
  # Seed the stick with the on-disk history it does not have yet.
  cp -n /var/backups/fooddesk/fooddesk-*.db.gz "$MNT/fooddesk-backups/" 2>/dev/null
  # Fresh consistent snapshot straight onto the stick (BACKUP_DIR override).
  BACKUP_DIR="$MNT/fooddesk-backups" "$BACKUP_SCRIPT" || return 1
  sync
}

case "${1:-}" in
  attach)
    PART="${2:-}"
    [ -n "$PART" ] || { echo "usage: usb-backup.sh attach <partition>"; exit 1; }
    DEV="$PART"; [ "${DEV#/dev/}" = "$DEV" ] && DEV="/dev/$DEV"

    # First stick wins; a second stick is ignored until the first leaves.
    if mountpoint -q "$MNT"; then
      log "$MNT already in use — ignoring $DEV"
      exit 0
    fi

    FSTYPE="$(blkid -o value -s TYPE "$DEV" 2>/dev/null || true)"
    # Fall back to direct superblock probing (works without the udev db).
    [ -n "$FSTYPE" ] || FSTYPE="$(blkid -p -o value -s TYPE "$DEV" 2>/dev/null || true)"
    case "$FSTYPE" in
      vfat) OPTS="rw,sync,flush,umask=077" ;;
      exfat) OPTS="rw,sync,umask=077" ;;
      ext4 | ext3 | ext2) OPTS="rw,sync" ;;
      *) log "unsupported filesystem '${FSTYPE:-none}' on $DEV — ignoring"; exit 0 ;;
    esac

    mkdir -p "$MNT"
    if ! mount -o "$OPTS" "$DEV" "$MNT"; then
      log "mount of $DEV failed"
      exit 0
    fi
    if snapshot_to_stick; then
      log "USB backup active on $DEV — snapshots mirror every 15 minutes"
    else
      log "initial snapshot to $DEV failed"
    fi
    ;;

  periodic)
    mountpoint -q "$MNT" || exit 0
    # A yanked stick leaves a dead mount behind. Two signals: the device
    # node vanishes (udev removes it), and a synchronous write probe fails
    # (mounts use -o sync, so this cannot be absorbed by the page cache).
    SRC="$(findmnt -rn -o SOURCE "$MNT" 2>/dev/null || true)"
    if [ -z "$SRC" ] || [ ! -b "$SRC" ] || ! touch "$MNT/.fooddesk-alive" 2>/dev/null; then
      log "backup stick is gone — cleaning up the stale mount"
      umount -l "$MNT" 2>/dev/null
      exit 0
    fi
    rm -f "$MNT/.fooddesk-alive"
    snapshot_to_stick || log "periodic snapshot to the stick failed"
    ;;

  *)
    echo "usage: usb-backup.sh attach <partition> | periodic"
    exit 1
    ;;
esac
