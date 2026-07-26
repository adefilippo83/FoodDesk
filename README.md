# FoodDesk

[![CI](https://github.com/adefilippo83/FoodDesk/actions/workflows/ci.yml/badge.svg)](https://github.com/adefilippo83/FoodDesk/actions/workflows/ci.yml)
[![CodeQL](https://github.com/adefilippo83/FoodDesk/actions/workflows/codeql.yml/badge.svg)](https://github.com/adefilippo83/FoodDesk/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/github/v/release/adefilippo83/FoodDesk?include_prereleases&sort=semver)](https://github.com/adefilippo83/FoodDesk/releases)
[![Node](https://img.shields.io/badge/node-24.x-339933?logo=node.js&logoColor=white)](deploy/README.md)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue)](LICENSE)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/adefilippo83/FoodDesk)

Ordering system for a temporary restaurant. Runs on a single Debian server on the
venue Wi-Fi; waiters connect from their phones over the LAN.

- **Admin** — manages categories, products, prices, users and settings.
- **Maître d'** (caposala) — like an admin for the menu, all orders and reports,
  but no Settings page and can only create/manage waiter accounts.
- **Operator** (waiter) — takes orders and prints them. Cannot change the menu.
- **Kitchen** — sees only the kitchen display (`/kitchen`): today's active orders
  on a tablet, tap an item to mark it done; the order completes with its last item.

## Stack

TypeScript · Fastify · SQLite (Drizzle) · React PWA (from phase 4) · pdfkit + CUPS printing

## Running locally

```bash
npm install
npm run migrate   # create/upgrade the database
npm run seed      # create the admin account (prints the password)
npm run dev       # API on :3000, UI on :5173
npm test          # ACL, auth, menu and order suites
```

Open **http://localhost:5173** in development — Vite proxies `/api` to the server.

For production (and for phones on the venue Wi-Fi), build once and run the server alone;
it serves the UI and the API from a single port:

```bash
npm run build
npm start --workspace server   # everything on http://<server-ip>:3000
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_FILE` | `./data/fooddesk.db` | SQLite file location |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Binds all interfaces so phones can reach it |
| `COOKIE_SECURE` | `false` | Set `true` when served over TLS |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / generated | Seed-time admin credentials |
| `KITCHEN_PRINTER` | unset | CUPS queue name for the kitchen printer (`lpstat -p` lists queues). Unset ⇒ tickets auto-open the browser's print dialog on order submit |
| `RESTAURANT_NAME` | `FoodDesk` | Default receipt header — the admin **Settings** page overrides this |
| `PDF_LANG` | `it` | Default receipt language — the Settings page overrides this |
| `CURRENCY_SYMBOL` | `€` | Currency symbol on receipts and totals |
| `SERVICE_DAY_CUTOFF_HOUR` | `5` | Orders before this hour count as the previous service day |

## Docker

Every push to `main` publishes `ghcr.io/adefilippo83/fooddesk:edge`; every
`v*` tag publishes `:latest` and `:X.Y.Z` (amd64 + arm64). One command runs
everything:

```bash
docker run -d --name fooddesk -p 3000:3000 -v fooddesk-data:/data \
  ghcr.io/adefilippo83/fooddesk:latest
docker logs fooddesk   # the generated admin password is printed on first start
```

The SQLite database lives in the `/data` volume. All the usual environment
variables apply; for printing, set `KITCHEN_PRINTER` plus `CUPS_SERVER=<host>`
so the container's `lp` talks to a CUPS server on the host or LAN. See
[deploy/docker-compose.yml](deploy/docker-compose.yml) for a ready-made
compose file. On every pull request the image is built **and booted** — the
CI smoke test waits for `/api/health` and performs a real login before the
image may be published on merge.

### Live demo

**https://fooddesk.fly.dev** — a shared instance redeployed from `main`, loaded
with a sample sagra evening and **reset every 6 hours** (the machine sleeps
when idle; the first request takes a few seconds to wake it). Demo accounts
(password **fooddesk-demo** for all):

| Username | Role |
|---|---|
| `admin` | admin |
| `giulia` | maître d' |
| `mario`, `lucia` | waiters |
| `cucina` | kitchen display |

### Try it in your browser

Click the *Open in GitHub Codespaces* badge above: the codespace builds the
app, starts it, and forwards port 3000 to an HTTPS URL. Sign in with
**admin / fooddesk-demo**. Each visitor gets their own throwaway instance
(free Codespaces quota applies); make the forwarded port public from the
Ports panel if you want to share the running demo with someone else.

## Design notes

- **Money is integer cents.** No floats anywhere in the money path.
- **Order items snapshot** product name, price and category, so editing the menu
  tomorrow never rewrites tonight's receipts.
- **Deletes are soft** (`active = false`) so historical orders keep resolving.
- **Authorization is server-side** on every route (`src/auth/acl.ts`). The UI hiding
  admin screens is cosmetic; `test/acl.test.ts` is the actual contract.
- **Passwords use Node's built-in scrypt** — no native module to compile on the server.
- **Security hardening**: login lockout (5 failures per IP+username → 15 min block),
  timing-equalized login, session eviction on password change/reset/disable, CSP +
  security headers, Origin check on writes, 64 KB body limit (3 MB only on settings
  uploads), image magic-byte validation, and an audit trail in the logs
  (`grep audit` in `journalctl -u fooddesk`).
- **The UI is bilingual (it/en)** via a typed dictionary in `web/src/i18n.tsx` — Italian by
  default on Italian browsers, toggle in the top bar, choice saved per device. Money follows
  the language (`28,50` vs `28.50`). PDFs are localized separately via `PDF_LANG`.

## Status

- [x] Phase 1 — scaffold, schema, migrations, seed
- [x] Phase 2 — auth, sessions, role-based ACL + tests
- [x] Phase 3 — admin: category & product CRUD
- [x] Phase 4 — operator: menu → cart → order, plus login and order list UI
- [x] Phase 5 — PDF receipts, kitchen ticket via CUPS, reprint + print-status tracking
- [x] Phase 6 — daily reports (product/category/waiter breakdowns), CSV export
- [x] Phase 7 — Debian deploy kit (`deploy/`): install script, systemd, nginx, 15-min backups, PWA
- [x] Phase 8 — coperto (configurable cover charge), mandatory customer name, order
  cancellation (audit, never delete), drag-reorder for menu, per-cover reporting +
  report PDF export, self-service & admin password management, admin Settings page
  (paper size, logo, header/footer, background watermark), browser auto-print fallback

## CI/CD

Every push and pull request runs through GitHub Actions (`.github/workflows/`):

| Workflow | When it runs | What it does |
|---|---|---|
| **CI** (`ci.yml`) | push to `main`, every PR | `npm ci` → test suites → full build, on Node 24 (the deploy target) and Node 26. Uploads the built `server/dist` + `server/public` as a downloadable artifact. |
| **CodeQL** (`codeql.yml`) | push, PR, weekly | Static security analysis with the `security-extended` query pack. |
| **Release** (`release.yml`) | tag `v*` | Tests + build, then publishes a GitHub Release with a deployable tarball and auto-generated notes. |

Dependabot (`.github/dependabot.yml`) opens a weekly PR batching minor/patch
dependency bumps (majors arrive individually), plus updates for the actions
themselves — CI validates each one like any other PR.

### Reading the badges

The badges at the top of this README show the project's health at a glance:

- ![CI passing](https://img.shields.io/badge/CI-passing-brightgreen) — the
  latest build on `main` compiled and every test suite passed. This is the one
  to check before pulling an update onto the venue server.
- ![CI failing](https://img.shields.io/badge/CI-failing-red) — `main` is
  broken; do not deploy until it is green again.
- **CodeQL** — green means the last security scan found no open alerts
  (details under the repo's *Security → Code scanning* tab).
- **Release** — the newest tagged version; clicking it opens the release with
  its tarball.
- **Node 24.x** — the runtime the Debian server is expected to run.

### Cutting a release

```bash
git tag v1.0.0
git push origin v1.0.0
```

The Release workflow does the rest: it refuses to publish if tests fail, and
otherwise attaches `fooddesk-v1.0.0.tar.gz` — unpack it on the server and run
`sudo deploy/install.sh` exactly as with a git checkout.

## Deploying

See [deploy/README.md](deploy/README.md) — on the Debian server it is one command:
`sudo deploy/install.sh`.

## License

FoodDesk is free software, released under the [GNU General Public License v3.0](LICENSE):
you may use, study, modify and redistribute it, but derivative works must stay
under the same license.
