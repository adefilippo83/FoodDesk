# Deploying FoodDesk on Debian

One small server on the venue Wi-Fi runs everything: the app, the database
and the kitchen printing. Waiters open the server's address on their phones
and add it to the home screen (the app ships a PWA manifest, so it installs
like a native app).

There are two supported ways to run it — pick one:

| | **A. Docker** (recommended for new installs) | **B. Bare metal** (systemd kit) |
|---|---|---|
| What runs | The exact image CI builds, boots and smoke-tests on every PR | Node 24 LTS + the code, built on the box |
| Install | Docker + one compose file | `sudo deploy/install.sh` |
| Update | `docker compose pull && docker compose up -d` | `git pull && sudo deploy/install.sh` |
| Rollback | Point the compose file at the previous version tag | `git checkout v…` + reinstall |
| Backups | One cron line (below) | Bundled 15-minute systemd timer |
| Printing | Via the **host's** CUPS (`CUPS_SERVER`) | Host CUPS, direct |

Either way, CUPS itself runs on the host — set the printer up once (§ Printing).

---

## A. Docker

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sh

# 2. The compose file
sudo mkdir -p /opt/fooddesk && cd /opt/fooddesk
sudo curl -fsSLO https://raw.githubusercontent.com/adefilippo83/FoodDesk/main/deploy/docker-compose.yml

# 3. Edit it: RESTAURANT_NAME, and later KITCHEN_PRINTER + CUPS_SERVER
sudo nano docker-compose.yml

# 4. Up
sudo docker compose up -d
sudo docker compose logs     # ← the generated admin password is printed once. Save it.
```

Open `http://<server-ip>/` — the compose file maps port 80, so phones just
type the IP. The SQLite database lives in `/opt/fooddesk/fooddesk-data/` on
the host.

**Update** (during the festival, prefer `:X.Y.Z` version tags over `:latest`
in the compose file, so updates only happen when you decide):

```bash
cd /opt/fooddesk && sudo docker compose pull && sudo docker compose up -d
```

**Backups** — a consistent snapshot every 15 minutes, kept one day deep
(96 rotating files named by time of day), plus 14 daily archives:

```bash
sudo apt-get install -y sqlite3
sudo mkdir -p /var/backups/fooddesk
sudo crontab -e   # add:
# */15 * * * * sqlite3 /opt/fooddesk/fooddesk-data/fooddesk.db ".backup /var/backups/fooddesk/quarter-$(date +\%H\%M).db"
# 30 4 * * *   sqlite3 /opt/fooddesk/fooddesk-data/fooddesk.db ".backup /var/backups/fooddesk/daily-$(date +\%u).db"
```

**Restore**: `docker compose down`, copy the chosen backup over
`fooddesk-data/fooddesk.db` (remove any `-wal`/`-shm` files), `up -d`.

**Emergency admin password reset**:

```bash
sudo docker compose exec -e ADMIN_PASSWORD=new-password fooddesk \
  node server/dist/db/seed.js
```

---

## B. Bare metal (systemd kit)

```bash
# 1. Node 24 LTS (Debian's packaged node is too old)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs nginx

# 2. Get the code onto the server (git clone or a release tarball), then:
cd FoodDesk
sudo deploy/install.sh
```

> Node 26 becomes LTS in late October 2026; until this repo's CI targets it,
> stay on 24 — it is supported through April 2028.

The installer is idempotent — it creates the `fooddesk` system user, builds
into `/opt/fooddesk`, seeds the admin account (**the generated password is
printed once — save it**), and enables:

- `fooddesk.service` — the app on `127.0.0.1:3000` behind nginx on port 80
- `fooddesk-backup.timer` — a consistent SQLite snapshot to
  `/var/backups/fooddesk` every 15 minutes, kept 14 days

**Configure**: edit `/etc/fooddesk/env`, then `systemctl restart fooddesk`
(`KITCHEN_PRINTER`, `RESTAURANT_NAME`, …).

**Update**: `cd FoodDesk && git pull && sudo deploy/install.sh` — database
migrations run automatically when the service starts.

**Restore a backup**:

```bash
systemctl stop fooddesk
gunzip -c /var/backups/fooddesk/fooddesk-<stamp>.db.gz > /var/lib/fooddesk/fooddesk.db
chown fooddesk:fooddesk /var/lib/fooddesk/fooddesk.db
systemctl start fooddesk
```

**Emergency admin password reset**:

```bash
cd /opt/fooddesk && sudo -u fooddesk \
  DATABASE_FILE=/var/lib/fooddesk/fooddesk.db ADMIN_PASSWORD=new-password \
  node server/dist/db/seed.js
```

---

## Printing (both paths)

CUPS runs on the host and drives any queue Debian can (thermal or laser):

```bash
apt-get install -y cups
lpinfo -v                          # how the printer is seen (usb://, socket://, ipp://)
lpadmin -p kitchen -E -v <uri> -m everywhere
lpstat -p                          # the queue name goes into KITCHEN_PRINTER
echo test | lp -d kitchen          # test page
```

- **Bare metal**: set `KITCHEN_PRINTER=kitchen` in `/etc/fooddesk/env`.
- **Docker**: the container's `lp` talks to the host's CUPS over the network.
  Allow that once — `sudo cupsctl --remote-any && sudo systemctl restart cups`
  (fine on a closed venue LAN) — then set in the compose file:
  `KITCHEN_PRINTER: kitchen` and `CUPS_SERVER: host.docker.internal:631`.

Until a printer is configured, kitchen tickets fall back to the browser's
print dialog on order submit.

## Notes

- Everything is LAN-only and plain HTTP. If you ever expose it beyond the
  venue network, put TLS in front and set `COOKIE_SECURE=true`.
- Bare metal: the service is sandboxed — it runs as the `fooddesk` user and
  can only write to `/var/lib/fooddesk`.
- Useful commands (bare metal): `journalctl -u fooddesk -f` for live logs,
  `systemctl list-timers fooddesk-*` for the next backup run. Docker:
  `docker compose logs -f`.
