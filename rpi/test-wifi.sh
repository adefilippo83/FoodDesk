#!/usr/bin/env bash
# Tier-2 CI Wi-Fi test: the appliance's access point, exercised over a real
# (virtual) radio. mac80211_hwsim gives the runner kernel two 802.11 radios
# with genuine WPA2 frames over a simulated air interface; one radio moves
# into the booted container's network namespace where NetworkManager runs
# the actual fooddesk-ap profile, the other stays on the host and plays the
# waiter's phone:
#
#   join the SSID with the WPA2 password from fooddesk.txt, get a DHCP
#   lease, resolve names through the catch-all DNS (plus Windows' NCSI
#   magic IP), pass the Android probe, and log into FoodDesk — end to end
#   over the air. Then reboot with a changed SSID+password and prove the
#   phone must (and can) join the new network.
#
# Runs on the arm64 runner (ubuntu-24.04-arm): the image executes natively
# — no qemu-user, under which NetworkManager aborts — and the x86 Azure
# kernels ship no Wi-Fi stack at all (actions/runner-images#1480).
#
#   usage: sudo rpi/test-wifi.sh <image-file>
set -Eeuo pipefail

IMG_SRC="${1:?usage: test-wifi.sh <image-file>}"
. "$(dirname "$0")/test-lib.sh"

CLIENT_IF=''
WPA_PID=''

# Minimal dhclient hook: assign the address and NOTHING else — the default
# script would rewrite the runner's /etc/resolv.conf with the AP's catch-all
# DNS and break every later workflow step. NM shared mode hands out /24.
DHS="$WORK/dhclient-addr-only.sh"
cat > "$DHS" <<'EOF'
#!/bin/bash
case "$reason" in
  BOUND | RENEW | REBIND | REBOOT)
    ip addr flush dev "$interface"
    ip addr add "$new_ip_address/24" dev "$interface"
    ;;
esac
EOF
chmod +x "$DHS"

dump_diagnostics() {
  say "DIAGNOSTICS"
  dump_base_diagnostics
  say "wifi state — container"
  run_in nmcli device 2>/dev/null || true
  run_in nmcli -f GENERAL,IP4 device show wlan0 2>/dev/null || true
  run_in nmcli connection show fooddesk-ap 2>/dev/null | head -30 || true
  run_in pgrep -a dnsmasq 2>/dev/null || true
  run_in pgrep -a wpa_supplicant 2>/dev/null || true
  say "wifi state — host"
  iw dev 2>/dev/null || true
  [ -n "$CLIENT_IF" ] && wpa_cli -i "$CLIENT_IF" status 2>/dev/null || true
  [ -n "$CLIENT_IF" ] && ip -4 addr show "$CLIENT_IF" 2>/dev/null || true
  dmesg 2>/dev/null | grep -i hwsim | tail -10 || true
}
trap dump_diagnostics ERR

cleanup_all() {
  [ -n "$WPA_PID" ] && kill "$WPA_PID" 2>/dev/null || true
  pkill -f "dhclient.*$CLIENT_IF" 2>/dev/null || true
  [ -n "$CLIENT_IF" ] && ip addr flush dev "$CLIENT_IF" 2>/dev/null || true
  cleanup_image
}
trap cleanup_all EXIT

join_and_verify() { # ssid, psk, label
  local ssid="$1" psk="$2" label="$3"

  say "AP up inside the container ($label)"
  local i up=''
  for i in $(seq 1 30); do
    if run_in nmcli -t -f DEVICE,STATE device 2>/dev/null | grep -q '^wlan0:connected'; then
      up=yes; break
    fi
    run_in nmcli connection up fooddesk-ap >/dev/null 2>&1 || true
    sleep 4
  done
  [ -n "$up" ] || { echo "fooddesk-ap never activated on wlan0"; false; }
  run_in pgrep dnsmasq >/dev/null
  echo "AP active with DHCP/DNS: ok"

  say "host client joins '$ssid' over the air"
  [ -n "$WPA_PID" ] && kill "$WPA_PID" 2>/dev/null || true
  dhclient -r "$CLIENT_IF" 2>/dev/null || true
  ip addr flush dev "$CLIENT_IF" 2>/dev/null || true
  local conf="$WORK/wpa-$label.conf"
  wpa_passphrase "$ssid" "$psk" > "$conf"
  ip link set "$CLIENT_IF" up
  wpa_supplicant -B -i "$CLIENT_IF" -c "$conf" -D nl80211 -P "$WORK/wpa.pid"
  WPA_PID="$(cat "$WORK/wpa.pid")"
  local joined=''
  for i in $(seq 1 30); do
    if wpa_cli -i "$CLIENT_IF" status 2>/dev/null | grep -q 'wpa_state=COMPLETED'; then
      joined=yes; break
    fi
    sleep 2
  done
  [ -n "$joined" ] || { echo "client never associated to $ssid"; false; }
  echo "WPA2 association: ok"

  timeout 60 dhclient -1 -sf "$DHS" "$CLIENT_IF"
  ip -4 addr show "$CLIENT_IF" | grep -q 'inet 10\.42\.0\.' \
    || { echo "no 10.42.0.x lease"; ip -4 addr show "$CLIENT_IF"; false; }
  echo "DHCP lease from the AP: ok"

  say "over-the-air behavior ($label)"
  [ "$(dig +short +time=3 +tries=2 @10.42.0.1 totally-random-name.example | tail -1)" = "10.42.0.1" ] \
    || { echo "catch-all DNS failed"; false; }
  echo "catch-all DNS: ok"
  [ "$(dig +short +time=3 +tries=2 @10.42.0.1 dns.msftncsi.com | tail -1)" = "131.107.255.255" ] \
    || { echo "NCSI magic DNS failed"; false; }
  echo "Windows NCSI DNS: ok"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' \
    --resolve connectivitycheck.gstatic.com:80:10.42.0.1 \
    http://connectivitycheck.gstatic.com/generate_204)"
  [ "$code" = 204 ] || { echo "Android probe returned $code"; false; }
  echo "Android probe over the air: ok"
  curl -fsS http://10.42.0.1/api/health | grep -q '"ok":true'
  echo "app reachable through nginx over the air: ok"
}

say "install host dependencies (wifi tooling)"
install_host_deps iw wpasupplicant dnsutils isc-dhcp-client

say "create two virtual radios"
echo "runner kernel: $(uname -r)"
if ! modprobe mac80211_hwsim radios=2 2>/dev/null; then
  # The module often lives in the kernel's modules-extra package.
  apt-get install -y -qq "linux-modules-extra-$(uname -r)" >/dev/null 2>&1 || true
  if ! modprobe mac80211_hwsim radios=2; then
    echo "FATAL: kernel $(uname -r) does not provide mac80211_hwsim"
    echo "-- wireless modules present:"
    find "/lib/modules/$(uname -r)" \( -name '*80211*' -o -name '*hwsim*' \) 2>/dev/null | head
    echo "-- kernel config:"
    grep -iE 'HWSIM|^CONFIG_MAC80211=|^CONFIG_CFG80211=' "/boot/config-$(uname -r)" 2>/dev/null || true
    exit 1
  fi
fi
sleep 2
iw dev
# The AP phy must carry the interface named wlan0 (the profile pins it);
# the other interface is the host-side client.
AP_PHY="$(iw dev | awk '/^phy/{phy=$0} /Interface wlan0$/{gsub("#","",phy); print phy}')"
CLIENT_IF="$(iw dev | awk '/Interface/{print $2}' | grep -v '^wlan0$' | head -1)"
[ -n "$AP_PHY" ] && [ -n "$CLIENT_IF" ] || { echo "could not map hwsim radios"; false; }
echo "AP phy: $AP_PHY — client interface: $CLIENT_IF"
# Keep any host network daemon's hands off the client radio.
command -v nmcli >/dev/null && nmcli device set "$CLIENT_IF" managed no 2>/dev/null || true
rfkill unblock wifi 2>/dev/null || true

say "prepare and boot the image"
prepare_image_copy "$IMG_SRC"
neutralize_for_nspawn
boot_machine
wait_active fooddesk-provision.service 90
wait_active fooddesk.service 30
wait_http http://127.0.0.1:3000/api/health

say "move the AP radio into the container"
LEADER="$(machinectl show "$M" -p Leader --value)"
iw phy "$AP_PHY" set netns "$LEADER"
for i in $(seq 1 15); do
  run_in ip link show wlan0 >/dev/null 2>&1 && break
  sleep 2
done
run_in ip link show wlan0 >/dev/null
echo "wlan0 visible inside the container: ok"

join_and_verify FoodDesk fooddesk-wifi default

say "a phone on the venue Wi-Fi can log in"
PASS="$(sed -n 's/^App password:  *//p' "$MNT/boot/firmware/fooddesk-info.txt")"
curl -fsS -X POST http://10.42.0.1/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PASS\"}" | grep -q '"role":"admin"'
echo "login over the air: ok"

say "reboot with a new SSID and password"
stop_machine
sed -i 's/^WIFI_SSID=.*/WIFI_SSID=CISagra2/' "$MNT/boot/firmware/fooddesk.txt"
sed -i 's/^WIFI_PASSWORD=.*/WIFI_PASSWORD=nuovapass99/' "$MNT/boot/firmware/fooddesk.txt"
boot_machine
wait_active fooddesk-provision.service 90
wait_active fooddesk.service 30
# The radio fell back to the host netns when the container died — move it in
# again for the new boot.
LEADER="$(machinectl show "$M" -p Leader --value)"
iw phy "$AP_PHY" set netns "$LEADER"
for i in $(seq 1 15); do
  run_in ip link show wlan0 >/dev/null 2>&1 && break
  sleep 2
done

join_and_verify CISagra2 nuovapass99 reprovisioned
echo "re-provisioned SSID + password applied over the air: ok"

say "ALL WIFI TESTS PASSED"
