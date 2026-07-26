#!/bin/sh
# Order matters: migrate first (the seed queries the users table), then the
# idempotent seed — it creates the admin account on the first start
# (printing the generated password to the container logs) and is a no-op
# afterwards. The server re-runs migrations at boot; that is a no-op too.
set -e
node server/dist/db/migrate.js
node server/dist/db/seed.js
exec node server/dist/index.js
