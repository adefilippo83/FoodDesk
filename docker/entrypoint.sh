#!/bin/sh
# Order matters: migrate first (the seed queries the users table), then the
# idempotent seed — it creates the admin account on the first start
# (printing the generated password to the container logs) and is a no-op
# afterwards. The server re-runs migrations at boot; that is a no-op too.
set -e

# A host bind-mount (deploy/docker-compose.yml maps ./fooddesk-data:/data) is
# created root-owned by the daemon, shadowing the image's chown, so the
# unprivileged 'node' user cannot create the database and the container
# crash-loops on first start. Start as root, fix ownership, then drop to node.
if [ "$(id -u)" = "0" ]; then
  chown node:node /data 2>/dev/null || true
  exec runuser -u node -- "$0" "$@"
fi

node server/dist/db/migrate.js
node server/dist/db/seed.js
exec node server/dist/index.js
