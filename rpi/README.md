# FoodDesk Raspberry Pi image

A flash-and-go appliance: power the Pi, join its Wi-Fi, take orders.
No Linux knowledge needed at the venue.

*Preferisci l'italiano? → [README.it.md](README.it.md)*

**Hardware**: Raspberry Pi 4 (2 GB+) or Pi 5 recommended; Pi 3 / Zero 2 W
work for small setups. The built-in radio comfortably serves ~10–20 devices
— for a bigger crew, plug a real access point into the Ethernet port (the
Pi's AP is a convenience, not a requirement).

## Use it

1. Download `fooddesk-rpi-<version>.img.xz` from the
   [releases page](https://github.com/adefilippo83/FoodDesk/releases) and
   flash it with [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
   or `dd` (skip Imager's OS customization — the image provisions itself).
2. *(Optional)* Re-insert the SD card and edit **`fooddesk.txt`** on the
   small `bootfs` partition — see [Configuration](#configuration-fooddesktxt)
   below. You can also do this later: the file is re-read at every boot.
3. Insert the card, power on, wait ~2 minutes for the first boot.
4. Join the **FoodDesk** Wi-Fi (default password `fooddesk-wifi`) and open
   **http://10.42.0.1/** — or `http://fooddesk.local/`, or actually any
   address: the AP's DNS answers everything with the Pi.
5. Credentials: the generated **admin password** is written to
   **`fooddesk-info.txt`** on the `bootfs` partition (read it from any
   laptop) and shown on an attached HDMI screen.

## Configuration (`fooddesk.txt`)

All venue configuration lives in one file, **`fooddesk.txt`**, on the SD
card's small FAT partition (`bootfs`) — the one any Windows/macOS/Linux
laptop can open. The image ships it with commented examples. Format rules:
one `KEY=VALUE` per line, no quotes (spaces in values are fine), lines
starting with `#` are ignored, Windows line endings are tolerated.

A filled-in sample:

```ini
# Wi-Fi network the venue devices will join (password: 8+ characters).
WIFI_SSID=SagraBorgo
WIFI_PASSWORD=festa2026!

# Two-letter Wi-Fi country code (regulatory domain).
WIFI_COUNTRY=IT

# Shown on receipts; can also be changed later in Settings.
RESTAURANT_NAME=Sagra del Borgo

# Language of printed documents: it, en, es, fr, pt.
PDF_LANG=it

# Attach an HDMI touchscreen and set "kitchen" to boot straight into the
# kitchen display; set "off" to turn the kiosk back off.
KIOSK=kitchen
```

| Key | Default | What it does |
|---|---|---|
| `WIFI_SSID` | `FoodDesk` | Name of the Wi-Fi network the Pi creates |
| `WIFI_PASSWORD` | `fooddesk-wifi` | WPA2 password, minimum 8 characters (shorter values are ignored) |
| `WIFI_COUNTRY` | `IT` | Two-letter regulatory country code for the radio |
| `RESTAURANT_NAME` | — | Receipt header; the in-app Settings page can override it later |
| `PDF_LANG` | `it` | Language of printed documents: `it`, `en`, `es`, `fr`, `pt` |
| `ADMIN_PASSWORD` | *(generated)* | Leave commented: a random password is generated on first boot. Setting it **(re)sets the admin password at the next boot** |
| `KIOSK` | *(off)* | `kitchen` boots the attached screen into the kitchen display; `off` disables it |

### Changing the configuration later

Edit `fooddesk.txt` — either by putting the SD card in a laptop, or over
SSH (`sudo nano /boot/firmware/fooddesk.txt`) — and **reboot**. The
provisioning service re-reads the file whenever it changed and re-applies
it; on a normal boot with an unchanged file it does nothing. After every
apply, `fooddesk-info.txt` and the QR leaflet next to it are rewritten to
match.

Two guarantees worth knowing:

- **The database is never touched** by reconfiguration — orders, menu and
  accounts survive any number of edits and reboots.
- **The admin password is never changed unless you set `ADMIN_PASSWORD`
  explicitly.** Which is also the recovery for a lost password: write
  `ADMIN_PASSWORD=something` in the file, reboot, log in, then remove the
  line (otherwise the next config edit would reset it again).

## What's inside

- Raspberry Pi OS Lite (arm64, Trixie) + Node 24
- FoodDesk as a hardened systemd service behind nginx on port 80, database
  in `/var/lib/fooddesk`, snapshotted every 15 minutes to
  `/var/backups/fooddesk` (same units as `deploy/`)
- A NetworkManager access-point profile (`fooddesk-ap`): WPA2, DHCP + DNS
  via `ipv4.method=shared`, catch-all DNS so any typed URL lands on FoodDesk
- **Works with no internet**: nginx answers the OS connectivity checks
  (Android `generate_204`, Apple `hotspot-detect`, Windows NCSI, Firefox) so
  phones and laptops treat the AP as online — no captive-portal prompts, no
  "no internet" nagging, no fallback to mobile data. A NetworkManager
  dispatcher hook flips the AP's DNS back to normal forwarding automatically
  whenever a real uplink is plugged in (Ethernet or USB tethering), giving
  clients genuine internet through NAT instead of the spoofed answers
- Provisioning (`fooddesk-provision.service`): applies `fooddesk.txt` on
  first boot and re-applies it whenever the file changes; seeds the admin
  account and writes `fooddesk-info.txt` + the QR leaflet
- Maintenance login `fooddesk-admin` / `fooddesk` (sudo; password change
  forced at first login), SSH enabled
- Ethernet stays free: plug in an uplink for internet or a network printer

## Printing

FoodDesk sends kitchen tickets as PDFs, so the printer needs a PDF-capable
CUPS queue:

- **Plug-and-play**: connect a USB printer that speaks IPP (most printers
  from ~2016 on, via `ipp-usb`) and the appliance auto-creates a driverless
  queue named `kitchen`, points `KITCHEN_PRINTER` at it and restarts the
  app. Tickets just print. Works the same for IPP network printers on the
  Ethernet port.
- **Everything else** (older thermal printers needing a driver): open the
  CUPS web interface at **http://10.42.0.1:631/** from any laptop on the
  FoodDesk Wi-Fi, log in as `fooddesk-admin`, and add the printer with the
  queue name `kitchen`. The hotplug helper wires up `KITCHEN_PRINTER` as
  soon as the queue exists.
- No printer at all: the browser print dialog fallback works as always.

## The venue leaflet

First boot also writes **`fooddesk-leaflet.pdf`** to the boot partition: an
A4 page with two QR codes — join the Wi-Fi, open FoodDesk — in Italian and
English. Print it and tape it up where the waiters gather. It carries the
Wi-Fi password but never the admin credentials.

## Kiosk mode: the Pi is the kitchen display

Attach an HDMI screen (ideally touch), set `KIOSK=kitchen` in
`fooddesk.txt`, reboot — the Pi boots straight into the kitchen display:
Chromium full-screen on a minimal Wayland compositor, no tablet needed.
`KIOSK=off` (and a reboot) turns it back off.

Under the hood: first boot creates a kitchen-role account with an unusable
random password and sets `KIOSK_AUTOLOGIN_USER` in `/etc/fooddesk/env`; the
kiosk browser then logs itself in through `/api/auth/kiosk`, a route that
only exists when that variable is set, only answers on the loopback
interface (never through nginx), and only accepts kitchen-role accounts —
so a phone on the venue Wi-Fi can never use it.

## Built for festival conditions

- **Power cuts**: logs live in RAM (volatile journald), there is no
  swapfile, and background apt/man-db jobs are off — the SD card sees
  almost no writes beyond the WAL database (torn-write safe by design) and
  its 15-minute snapshots. Pulling the plug is a non-event in practice;
  still, buy a decent SD card.
- **Hangs**: the hardware watchdog reboots a wedged box within seconds;
  the FoodDesk service itself always restarts on crash.

## USB stick backups

Plug any USB stick (FAT32/exFAT/ext4) into the Pi: it gets a
`fooddesk-backups/` folder with the existing snapshot history plus a fresh
snapshot, then mirrors every 15 minutes for as long as it stays in.
Nothing else on the stick is touched. Mounts are synchronous, so pulling
the stick out without ceremony is fine — worst case you lose the snapshot
being written that second, never the ones before. Leave a stick in for the
whole service and the night's ledger survives even a dead SD card.

## Updating

With an internet uplink plugged in:

```bash
sudo fooddesk-update            # latest release (or: fooddesk-update v1.2.3)
```

It snapshots the database, downloads the release tarball, installs, swaps,
and health-checks — rolling back automatically if the new version does not
come up. `sudo fooddesk-update --rollback` returns to the previous version
at any time. The database is never touched by updates.

## Build it yourself

The image is baked by `.github/workflows/rpi-image.yml` on every release:
the web/server build runs natively on the runner, then `rpi/setup.sh`
customizes the stock Raspberry Pi OS image inside a QEMU chroot
(`pguyot/arm-runner-action`) and the result is compressed and attached to
the release with its SHA256.

**Testing a change**: PRs that touch `rpi/**` (or the workflow) build the
image automatically — download the `.img.xz` from the run's artifacts. For
any other branch, run the workflow manually from the Actions tab
(*workflow dispatch*, pick the branch). A bake takes ~30–60 minutes.
