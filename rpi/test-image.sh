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
# No Wi-Fi radio exists in this test: the provisioning script's nmcli steps
# degrade non-fatally by design (rpi/test-wifi.sh covers the radio with
# mac80211_hwsim). The shipped artifact is never touched — we boot a copy.
#
#   usage: sudo rpi/test-image.sh <image-file>
set -Eeuo pipefail

IMG_SRC="${1:?usage: test-image.sh <image-file>}"
. "$(dirname "$0")/test-lib.sh"

dump_diagnostics() {
  say "DIAGNOSTICS"
  dump_base_diagnostics
  # journald is typically dead in the emulated boot, so the unit's own
  # output is lost — replay provisioning interactively to capture it.
  say "provision.sh replay (stdout captured)"
  run_in bash /opt/fooddesk/rpi/provision.sh || true
  say "nginx -t inside the container"
  run_in /usr/sbin/nginx -t || true
}
trap dump_diagnostics ERR
trap cleanup_image EXIT

say "install host dependencies"
install_host_deps

say "prepare a disposable copy of the image"
prepare_image_copy "$IMG_SRC"

say "neutralize hardware-specific units for the container boot"
neutralize_for_nspawn

say "canary: arm64 emulation works against the image rootfs"
systemd-nspawn -q -D "$MNT" /usr/local/bin/node --version

say "BOOT 1 — pristine image, first provisioning"
boot_machine
wait_active fooddesk-provision.service 90
wait_active fooddesk.service 30

say "app health + services"
wait_http http://127.0.0.1:3000/api/health
run_in curl -fsS http://127.0.0.1:3000/api/health | grep -q '"ok":true'
echo "health: ok"
run_in systemctl is-active --quiet fooddesk-backup.timer
run_in systemctl is-active --quiet fooddesk-usb-backup.timer
echo "backup timers: active"

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

say "nginx serves the app and answers connectivity probes"
wait_active nginx.service 30
wait_http http://127.0.0.1/generate_204
CODE="$(run_in curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/generate_204)"
[ "$CODE" = 204 ] || { echo "generate_204 returned $CODE"; false; }
run_in curl -s -H 'Host: captive.apple.com' http://127.0.0.1/hotspot-detect.html | grep -q Success
run_in curl -s -H 'Host: www.msftconnecttest.com' http://127.0.0.1/connecttest.txt \
  | grep -q 'Microsoft Connect Test'
run_in curl -fsS http://127.0.0.1/ | grep -qi '<!doctype html'
echo "probes + SPA: ok"

say "power off and edit fooddesk.txt"
stop_machine
sed -i 's/^WIFI_SSID=.*/WIFI_SSID=CISagra/' "$MNT/boot/firmware/fooddesk.txt"
sed -i 's/^#RESTAURANT_NAME=.*/RESTAURANT_NAME=CI Sagra/' "$MNT/boot/firmware/fooddesk.txt"

say "BOOT 2 — config change is re-applied, admin password survives"
boot_machine
wait_active fooddesk-provision.service 90
wait_active fooddesk.service 30
wait_http http://127.0.0.1:3000/api/health
# Values land shell-QUOTED. The updater and the backup scripts source this
# file under `set -e`, where an unquoted multi-word value makes the shell run
# its stray words as commands ("Sagra del Borgo" → `del Borgo`) and abort.
grep -q "^RESTAURANT_NAME='CI Sagra'\$" "$MNT/etc/fooddesk/env"
run_in sh -c 'set -eu; . /etc/fooddesk/env; test "$RESTAURANT_NAME" = "CI Sagra"'
echo "restaurant name applied, sources cleanly in a shell: ok"
# systemd strips those quotes again on the way to the app — a literal quote
# here would end up printed on every receipt.
wait_app_env 'RESTAURANT_NAME=CI Sagra'
echo "app process sees the unquoted value: ok"
grep -q 'CISagra' "$INFO" && grep -q 'App password:  *(unchanged)' "$INFO"
echo "info file rewritten, password untouched: ok"
run_in curl -fsS -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PASS\"}" | grep -q '"role":"admin"'
echo "login with ORIGINAL password after re-provision: ok"

say "ALL BOOT TESTS PASSED"
