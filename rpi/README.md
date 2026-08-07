# FoodDesk Raspberry Pi image

A flash-and-go appliance: power the Pi, join its Wi-Fi, take orders.
No Linux knowledge needed at the venue.

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
   small `bootfs` partition: Wi-Fi name/password, country code, restaurant
   name, language.
3. Insert the card, power on, wait ~2 minutes for the first boot.
4. Join the **FoodDesk** Wi-Fi (default password `fooddesk-wifi`) and open
   **http://10.42.0.1/** — or `http://fooddesk.local/`, or actually any
   address: the AP's DNS answers everything with the Pi.
5. Credentials: the generated **admin password** is written to
   **`fooddesk-info.txt`** on the `bootfs` partition (read it from any
   laptop) and shown on an attached HDMI screen.

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
- First-boot provisioning (`fooddesk-firstboot.service`): applies
  `fooddesk.txt`, seeds the admin account, writes `fooddesk-info.txt`
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

Attach an HDMI screen (ideally touch), uncomment `KIOSK=kitchen` in
`fooddesk.txt`, and the Pi boots straight into the kitchen display —
Chromium full-screen on a minimal Wayland compositor, no tablet needed.

Under the hood: first boot creates a kitchen-role account with an unusable
random password and sets `KIOSK_AUTOLOGIN_USER` in `/etc/fooddesk/env`; the
kiosk browser then logs itself in through `/api/auth/kiosk`, a route that
only exists when that variable is set, only answers on the loopback
interface (never through nginx), and only accepts kitchen-role accounts —
so a phone on the venue Wi-Fi can never use it. To turn the kiosk off:
`sudo systemctl disable --now fooddesk-kiosk.service`.

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

## Re-provision / recover

Edit `fooddesk.txt`, then on the Pi:

```bash
sudo rm /etc/fooddesk/.initialized && sudo reboot
```

The database is kept; only Wi-Fi settings and the admin password are
re-applied (set `ADMIN_PASSWORD` in `fooddesk.txt` to reset a lost login —
same emergency path as the standard seed).

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
