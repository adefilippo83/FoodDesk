# syntax=docker/dockerfile:1
# FoodDesk in one container: API + built PWA on port 3000, SQLite in /data.
# Build:  docker build -t fooddesk .
# Run:    docker run -d -p 3000:3000 -v fooddesk-data:/data fooddesk
#         (first start prints the generated admin password in the logs)

# ---- build stage: compile web + server, native deps included ----
FROM node:24-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime stage: slim image, only what the venue server needs ----
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    DATABASE_FILE=/data/fooddesk.db \
    HOST=0.0.0.0 \
    PORT=3000

# `lp` lets the container print to a CUPS server on the host or LAN
# (set KITCHEN_PRINTER plus CUPS_SERVER=<host:port>).
RUN apt-get update \
  && apt-get install -y --no-install-recommends cups-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/public server/public
COPY --from=build /app/server/drizzle server/drizzle
COPY docker/entrypoint.sh /usr/local/bin/fooddesk-entrypoint

RUN chmod +x /usr/local/bin/fooddesk-entrypoint \
  && mkdir -p /data && chown node:node /data
# NOTE: no `USER node` here. The entrypoint starts as root ONLY to fix the
# ownership of a root-owned host bind-mount, then drops to `node` for the app
# (see docker/entrypoint.sh). A named volume already has correct ownership, so
# the chown is a harmless no-op there.
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["fooddesk-entrypoint"]
