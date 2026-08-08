#!/usr/bin/env bash
# Tier-1 CI boot test for the baked Raspberry Pi image. Runs on the x86
# GitHub runner as root: boots a COPY of the image's root filesystem under
# systemd-nspawn with arm64 user-mode emulation — real systemd, real units —
# and asserts the appliance behavior that a chroot can't see:
#
#   boot 1 (pristine image): provisioning runs, the app and nginx come up,
#     the connectivity probes answer, the generated admin password lands in
#     fooddesk-info.txt and actually logs in, the QR leaflet exists
#   boot 2 (edited fooddesk.txt): the config is re-applied and the admin
#     password from boot 1 still works
#
# No Wi-Fi radio exists in the container: the provisioning script's nmcli
# steps degrade non-fatally by design, exactly like on hardware without a
# radio. The shipped artifact is never touched — we boot a copy.
#
#   usage: sudo rpi/test-image.sh <image-file>
set -Eeuo pipefail

IMG_SRC="${1:?usage: test-image.sh <image-file>}"
M=fooddesk-test
WORK="${RUNNER_TEMP:-/tmp}"
IMG="$WORK/fooddesk-boot-test.img"
MNT="$(mktemp -d)"
LOOP=''
NSPAWN_PID=''

say() { echo; echo "### $*"; }

run_in() { systemd-run --machine="$M" --wait --pipe --quiet "$@"; }

dump_diagnostics() {
  say "DIAGNOSTICS"
  run_in systemctl status --no-pager fooddesk-provision.service fooddesk.service 2>/dev/null || true
  run_in systemctl list-jobs --no-pager 2>/dev/null || true
  run_in systemctl --no-pager --failed 2>/dev/null | grep -v 'run-u' || true
  run_in journalctl -b --no-pager -n 80 2>/dev/null || true
  say "console tail"
  tail -n 60 "$WORK/nspawn.log" 2>/dev/null || true
}
trap dump_diagnostics ERR

stop_machine() {
  machinectl poweroff "$M" 2>/dev/null || true
  for i in $(seq 1 30); do
    machinectl show "$M" >/dev/null 2>&1 || break
    sleep 2
  done
  machinectl terminate "$M" 2>/dev/null || true
  [ -n "$NSPAWN_PID" ] && wait "$NSPAWN_PID" 2>/dev/null || true
  NSPAWN_PID=''
}

cleanup() {
  stop_machine
  umount "$MNT/boot/firmware" 2>/dev/null || true
  umount "$MNT" 2>/dev/null || true
  [ -n "$LOOP" ] && losetup -d "$LOOP" 2>/dev/null || true
  rm -rf "$MNT" "$IMG"
}
trap cleanup EXIT

boot_machine() {
  systemd-nspawn --boot -D "$MNT" --machine="$M" --private-network \
    > "$WORK/nspawn.log" 2>&1 &
  NSPAWN_PID=$!
}

wait_active() { # unit, timeout-iterations (x5s)
  local unit="$1" tries="${2:-60}"
  for i in $(seq 1 "$tries"); do
    if run_in systemctl is-active --quiet "$unit" 2>/dev/null; then return 0; fi
    kill -0 "$NSPAWN_PID" 2>/dev/null || { echo "container died while waiting for $unit"; return 1; }
    sleep 5
  done
  echo "timeout waiting for $unit"
  return 1
}

say "install host dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq systemd-container qemu-user-static binfmt-support >/dev/null
systemctl restart systemd-binfmt 2>/dev/null || true

say "prepare a disposable copy of the image"
cp "$IMG_SRC" "$IMG"
LOOP="$(losetup -fP --show "$IMG")"
mount "${LOOP}p2" "$MNT"
mount "${LOOP}p1" "$MNT/boot/firmware"

say "neutralize hardware-specific units for the container boot"
# The disposable copy (never the shipped image) gets the standard
# foreign-image-under-nspawn treatment: no PARTUUID fstab mounts, no
# Raspberry zram/swap plumbing, no cloud-init, no EEPROM checks — none of
# which exist inside a container and all of which otherwise fail loudly.
: > "$MNT/etc/fstab"
mkdir -p "$MNT/etc/cloud" && touch "$MNT/etc/cloud/cloud-init.disabled"
for u in systemd-remount-fs.service swap.target \
         rpi-resize-swap-file.service 'rpi-setup-loop@var-swap.service' \
         'systemd-zram-setup@zram0.service' dev-zram0.swap \
         rpi-eeprom-update.service; do
  ln -sf /dev/null "$MNT/etc/systemd/system/$u"
done

say "canary: arm64 emulation works against the image rootfs"
systemd-nspawn -q -D "$MNT" /usr/local/bin/node --version

say "BOOT 1 — pristine image, first provisioning"
boot_machine
wait_active fooddesk-provision.service 90
wait_active fooddesk.service 30
wait_active nginx.service 30

say "app health + services"
run_in curl -fsS http://127.0.0.1:3000/api/health | grep -q '"ok":true'
echo "health: ok"
run_in systemctl is-active --quiet fooddesk-backup.timer
run_in systemctl is-active --quiet fooddesk-usb-backup.timer
echo "backup timers: active"

say "nginx serves the app and answers connectivity probes"
CODE="$(run_in curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/generate_204)"
[ "$CODE" = 204 ] || { echo "generate_204 returned $CODE"; false; }
run_in curl -s -H 'Host: captive.apple.com' http://127.0.0.1/hotspot-detect.html | grep -q Success
run_in curl -s -H 'Host: www.msftconnecttest.com' http://127.0.0.1/connecttest.txt \
  | grep -q 'Microsoft Connect Test'
run_in curl -fsS http://127.0.0.1/ | grep -qi '<!doctype html'
echo "probes + SPA: ok"

say "generated credentials work"
INFO="$MNT/boot/firmware/fooddesk-info.txt"
[ -f "$INFO" ] || { echo "fooddesk-info.txt missing"; false; }
PASS="$(sed -n 's/^App password:  *//p' "$INFO")"
echo "$PASS" | grep -Eq '^[a-z0-9]{12}$' || { echo "unexpected generated password: '$PASS'"; false; }
run_in curl -fsS -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PASS\"}" | grep -q '"role":"admin"'
echo "login with generated password: ok"
head -c 5 "$MNT/boot/firmware/fooddesk-leaflet.pdf" | grep -q '%PDF-'
echo "leaflet: ok"

say "power off and edit fooddesk.txt"
stop_machine
sed -i 's/^WIFI_SSID=.*/WIFI_SSID=CISagra/' "$MNT/boot/firmware/fooddesk.txt"
sed -i 's/^#RESTAURANT_NAME=.*/RESTAURANT_NAME=CI Sagra/' "$MNT/boot/firmware/fooddesk.txt"

say "BOOT 2 — config change is re-applied, admin password survives"
boot_machine
wait_active fooddesk-provision.service 90
wait_active fooddesk.service 30
grep -q '^RESTAURANT_NAME=CI Sagra$' "$MNT/etc/fooddesk/env"
echo "restaurant name applied: ok"
grep -q 'CISagra' "$INFO" && grep -q 'App password:  *(unchanged)' "$INFO"
echo "info file rewritten, password untouched: ok"
run_in curl -fsS -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PASS\"}" | grep -q '"role":"admin"'
echo "login with ORIGINAL password after re-provision: ok"

say "ALL BOOT TESTS PASSED"
