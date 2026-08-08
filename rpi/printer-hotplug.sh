#!/usr/bin/env bash
# Best-effort plug-and-play for a USB printer on the FoodDesk appliance.
# Triggered by udev (rpi/99-fooddesk-printer.rules) whenever a USB printer
# appears, including at boot for one already plugged in.
#
# FoodDesk sends PDFs to the queue, so the queue must be PDF-capable: we
# only auto-create a driverless (IPP Everywhere) queue, which works for
# modern printers exposing IPP — over USB via ipp-usb, or on the LAN. For
# anything older, the CUPS web UI at http://10.42.0.1:631/ (login
# fooddesk-admin) is the manual path; this script then just wires the env.
set -uo pipefail

QUEUE=kitchen
ENV_FILE=/etc/fooddesk/env

log() { logger -t fooddesk-printer "$*"; echo "$*"; }

# CUPS may still be starting (boot coldplug).
for i in $(seq 1 15); do
  lpstat -r >/dev/null 2>&1 && break
  sleep 2
done

if ! lpstat -p "$QUEUE" >/dev/null 2>&1; then
  # Give ipp-usb a moment to claim the device and expose IPP.
  URI=''
  for i in $(seq 1 10); do
    URI="$(driverless list 2>/dev/null | head -1)"
    [ -n "$URI" ] && break
    sleep 3
  done
  if [ -z "$URI" ]; then
    log "no driverless-capable printer found — set one up at http://10.42.0.1:631/ (queue name: $QUEUE)"
    exit 0
  fi
  if ! lpadmin -p "$QUEUE" -E -v "$URI" -m everywhere 2>&1 | logger -t fooddesk-printer; then
    log "lpadmin failed for $URI"
    exit 0
  fi
  lpadmin -d "$QUEUE" || true
  cupsenable "$QUEUE" 2>/dev/null || true
  cupsaccept "$QUEUE" 2>/dev/null || true
  log "created driverless queue '$QUEUE' for $URI"
fi

# Point FoodDesk at the queue (once) and restart so the env change lands.
if ! grep -q "^KITCHEN_PRINTER=$QUEUE\$" "$ENV_FILE"; then
  if grep -q '^#\?KITCHEN_PRINTER=' "$ENV_FILE"; then
    sed -i "s|^#\?KITCHEN_PRINTER=.*|KITCHEN_PRINTER=$QUEUE|" "$ENV_FILE"
  else
    echo "KITCHEN_PRINTER=$QUEUE" >> "$ENV_FILE"
  fi
  systemctl restart fooddesk.service || true
  log "KITCHEN_PRINTER=$QUEUE configured — kitchen tickets will print automatically"
fi

exit 0
