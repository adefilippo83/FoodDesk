#!/bin/sh
# Migrations run inside the server at boot; the seed is idempotent — it
# creates the admin account on the first start (printing the generated
# password to the container logs) and is a no-op afterwards.
set -e
node server/dist/db/seed.js
exec node server/dist/index.js
