# Deploying FoodDesk on Debian

One small server on the venue Wi-Fi runs everything: the app, the database and
the kitchen printing. Waiters open the server's address on their phones and
add it to the home screen (the app ships a PWA manifest, so it installs like
a native app).

## First install

```bash
# 1. Node 24 LTS (Debian's packaged node is too old)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs nginx

# 2. Get the code onto the server (git clone or scp), then:
cd FoodDesk
sudo deploy/install.sh
```

The installer is idempotent — it creates the `fooddesk` system user, builds
into `/opt/fooddesk`, seeds the admin account (**the generated password is
printed once — save it**), and enables:

- `fooddesk.service` — the app on `127.0.0.1:3000` behind nginx on port 80
- `fooddesk-backup.timer` — a consistent SQLite snapshot to
  `/var/backups/fooddesk` every 15 minutes, kept 14 days

## Configure

Edit `/etc/fooddesk/env`, then `systemctl restart fooddesk`:

- `KITCHEN_PRINTER` — the CUPS queue name for the kitchen printer.
  Set the printer up first: `apt-get install cups`, add the printer
  (`lpadmin` or the CUPS web UI on `localhost:631`), check `lpstat -p`,
  test with `echo test | lp -d <queue>`. Until this is set, kitchen tickets
  are printed from the browser via each order's "PDF cucina" button.
- `RESTAURANT_NAME` — header on customer receipts.

## Update

```bash
cd FoodDesk && git pull && sudo deploy/install.sh
```

Database migrations run automatically when the service starts.

## Restore a backup

```bash
systemctl stop fooddesk
gunzip -c /var/backups/fooddesk/fooddesk-<stamp>.db.gz > /var/lib/fooddesk/fooddesk.db
chown fooddesk:fooddesk /var/lib/fooddesk/fooddesk.db
systemctl start fooddesk
```

## Useful commands

```bash
journalctl -u fooddesk -f            # live logs (ACL denials, print errors)
systemctl list-timers fooddesk-*     # next backup run
sqlite3 /var/lib/fooddesk/fooddesk.db 'select count(*) from orders;'
```

## Notes

- Everything is LAN-only and plain HTTP. If you ever expose it beyond the
  venue network, put TLS in front and set `COOKIE_SECURE=true`.
- The service is sandboxed: it runs as the `fooddesk` user and can only write
  to `/var/lib/fooddesk`.
