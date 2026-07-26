#!/bin/sh
# Codespaces demo bootstrap. Demo credentials: admin / fooddesk-demo
#
# Codespaces reaps children of lifecycle commands once they finish, so the
# server must fully detach (setsid + closed stdin) or it dies right after
# "Finished configuring codespace". The loop restarts it if it ever crashes.
set -e
cd "$(dirname "$0")/.."

# postStart runs on every codespace start — don't stack a second instance.
if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
  echo "FoodDesk demo already running on port 3000"
  exit 0
fi

export ADMIN_USERNAME=admin
export ADMIN_PASSWORD=fooddesk-demo

node server/dist/db/migrate.js
node server/dist/db/seed.js

setsid sh -c 'while :; do node server/dist/index.js >> /tmp/fooddesk.log 2>&1; sleep 2; done' \
  </dev/null >/dev/null 2>&1 &

echo "FoodDesk demo running on port 3000 — sign in with admin / fooddesk-demo"
