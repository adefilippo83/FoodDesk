#!/bin/sh
# Codespaces demo bootstrap. Demo credentials: admin / fooddesk-demo
#
# Codespaces may reap lifecycle-spawned processes (cgroup-wide, so setsid
# alone cannot escape it). Defense in depth: this script is idempotent and
# wired to BOTH postStart and postAttach — whenever someone actually opens
# the codespace, a dead demo server comes back on its own. Boot traces go
# to ./data/ (persisted across restarts), not /tmp (wiped every restart).
set -e
cd "$(dirname "$0")/.."
mkdir -p ./data
BOOT_LOG=./data/demo-boot.log
echo "[$(date -u '+%F %T')] start-demo invoked (node: $(command -v node || echo MISSING))" >> "$BOOT_LOG"

if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
  echo "[$(date -u '+%F %T')] already running" >> "$BOOT_LOG"
  echo "FoodDesk demo already running on port 3000"
  exit 0
fi

export ADMIN_USERNAME=admin
export ADMIN_PASSWORD=fooddesk-demo

node server/dist/db/migrate.js >> "$BOOT_LOG" 2>&1
node server/dist/db/seed.js >> "$BOOT_LOG" 2>&1

# postStart and postAttach can race each other into two supervisors: each
# iteration first checks whether someone else already serves the port and
# bows out if so, so duplicates converge to exactly one.
setsid sh -c '
  echo "[$(date -u "+%F %T")] supervisor up (pid $$)" >> ./data/demo-boot.log
  while :; do
    if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      echo "[$(date -u "+%F %T")] port already served — supervisor $$ exiting" >> ./data/demo-boot.log
      exit 0
    fi
    node server/dist/index.js >> ./data/demo-server.log 2>&1
    echo "[$(date -u "+%F %T")] server exited, restarting" >> ./data/demo-boot.log
    sleep 2
  done
' </dev/null >/dev/null 2>&1 &

echo "FoodDesk demo running on port 3000 — sign in with admin / fooddesk-demo"
