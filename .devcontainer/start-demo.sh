#!/bin/sh
# Codespaces demo bootstrap: seed the demo admin (idempotent) and start the
# built server in the background. Demo credentials: admin / fooddesk-demo
set -e
cd "$(dirname "$0")/.."

export ADMIN_USERNAME=admin
export ADMIN_PASSWORD=fooddesk-demo

node server/dist/db/migrate.js
node server/dist/db/seed.js
nohup node server/dist/index.js > /tmp/fooddesk.log 2>&1 &
echo "FoodDesk demo running on port 3000 — sign in with admin / fooddesk-demo"
