# Shared plumbing for the CI image tests (sourced by rpi/test-image.sh and
# rpi/test-wifi.sh): boot a disposable COPY of the baked image under
# systemd-nspawn with arm64 emulation, with the container-hostile bits of
# Raspberry Pi OS neutralized. Callers define their own assertions, traps
# and diagnostics on top.
#
# Globals set here: M WORK IMG MNT LOOP NSPAWN_PID

M="${M:-fooddesk-test}"
WORK="${RUNNER_TEMP:-/tmp}"
IMG="$WORK/fooddesk-boot-test.img"
MNT="$(mktemp -d)"
LOOP=''
NSPAWN_PID=''

say() { echo; echo "### $*"; }

run_in() { systemd-run --machine="$M" --wait --pipe --quiet "$@"; }

install_host_deps() { # extra packages as args
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null
  apt-get install -y -qq systemd-container qemu-user-static binfmt-support "$@" >/dev/null
  systemctl restart systemd-binfmt 2>/dev/null || true
}

prepare_image_copy() { # image-file
  cp "$1" "$IMG"
  LOOP="$(losetup -fP --show "$IMG")"
  mount "${LOOP}p2" "$MNT"
  mount "${LOOP}p1" "$MNT/boot/firmware"
}

neutralize_for_nspawn() {
  # The disposable copy (never the shipped image) gets the standard
  # foreign-image-under-nspawn treatment: no PARTUUID fstab mounts, no
  # Raspberry zram/swap plumbing, no cloud-init, no EEPROM checks — none of
  # which exist inside a container and all of which otherwise fail loudly.
  : > "$MNT/etc/fstab"
  mkdir -p "$MNT/etc/cloud" && touch "$MNT/etc/cloud/cloud-init.disabled"
  local u
  for u in systemd-remount-fs.service swap.target \
           rpi-resize-swap-file.service 'rpi-setup-loop@var-swap.service' \
           'systemd-zram-setup@zram0.service' dev-zram0.swap \
           rpi-eeprom-update.service systemd-firstboot.service userconfig.service; do
    ln -sf /dev/null "$MNT/etc/systemd/system/$u"
  done

  # qemu-user cannot emulate the new mount-API syscalls Trixie's systemd
  # uses for service sandboxing, so every namespaced unit dies with
  # status=226/NAMESPACE. CI-only: switch the sandboxing knobs off for the
  # emulated boot. The hardening is systemd's contract, not ours to test.
  mkdir -p "$MNT/etc/systemd/system/service.d"
  cat > "$MNT/etc/systemd/system/service.d/zz-ci-nspawn.conf" <<'EOF'
[Service]
PrivateTmp=no
PrivateDevices=no
PrivateMounts=no
ProtectSystem=no
ProtectHome=no
ProtectControlGroups=no
ProtectKernelTunables=no
ProtectKernelModules=no
ProtectKernelLogs=no
ProtectClock=no
ProtectHostname=no
ProtectProc=default
ProcSubset=all
RestrictNamespaces=no
RestrictRealtime=no
LockPersonality=no
MemoryDenyWriteExecute=no
ReadWritePaths=
ReadOnlyPaths=
InaccessiblePaths=
NoExecPaths=
RestrictAddressFamilies=
SystemCallFilter=
SystemCallArchitectures=
EOF
}

boot_machine() {
  systemd-nspawn --boot -D "$MNT" --machine="$M" --private-network \
    > "$WORK/nspawn.log" 2>&1 &
  NSPAWN_PID=$!
}

stop_machine() {
  machinectl poweroff "$M" 2>/dev/null || true
  local i
  for i in $(seq 1 30); do
    machinectl show "$M" >/dev/null 2>&1 || break
    sleep 2
  done
  machinectl terminate "$M" 2>/dev/null || true
  [ -n "$NSPAWN_PID" ] && wait "$NSPAWN_PID" 2>/dev/null || true
  NSPAWN_PID=''
}

cleanup_image() {
  stop_machine
  umount "$MNT/boot/firmware" 2>/dev/null || true
  umount "$MNT" 2>/dev/null || true
  [ -n "$LOOP" ] && losetup -d "$LOOP" 2>/dev/null || true
  rm -rf "$MNT" "$IMG"
}

wait_http() { # url, timeout-iterations (x4s) — a service can be "active"
  # seconds before node has migrated and bound the port under emulation.
  local url="$1" tries="${2:-30}" i
  for i in $(seq 1 "$tries"); do
    if run_in curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 4
  done
  echo "timeout waiting for $url"
  return 1
}

wait_app_env() { # KEY=VALUE, timeout-iterations (x4s) — provisioning restarts
  # the app with --no-block, so the new process may not be up yet.
  local want="$1" tries="${2:-15}" i
  for i in $(seq 1 "$tries"); do
    if run_in sh -c \
      "p=\$(systemctl show -p MainPID --value fooddesk.service); tr '\\0' '\\n' < /proc/\$p/environ | grep -qxF '$want'" \
      2>/dev/null; then
      return 0
    fi
    sleep 4
  done
  echo "timeout waiting for the app process to see $want"
  return 1
}

wait_active() { # unit, timeout-iterations (x5s)
  local unit="$1" tries="${2:-60}" i
  for i in $(seq 1 "$tries"); do
    if run_in systemctl is-active --quiet "$unit" 2>/dev/null; then return 0; fi
    kill -0 "$NSPAWN_PID" 2>/dev/null || { echo "container died while waiting for $unit"; return 1; }
    sleep 5
  done
  echo "timeout waiting for $unit"
  return 1
}

dump_base_diagnostics() {
  run_in systemctl status --no-pager fooddesk-provision.service fooddesk.service nginx.service 2>/dev/null || true
  run_in systemctl list-jobs --no-pager 2>/dev/null || true
  run_in systemctl --no-pager --failed 2>/dev/null | grep -v 'run-u' || true
  say "console tail"
  tail -n 60 "$WORK/nspawn.log" 2>/dev/null || true
}
