# FoodDesk

Ordering system for a temporary restaurant. Runs on a single Debian server on the
venue Wi-Fi; waiters connect from their phones over the LAN.

- **Admin** — manages categories, products, prices and users.
- **Operator** (waiter) — takes orders and prints them. Cannot change the menu.

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
| `KITCHEN_PRINTER` | unset | CUPS queue name for the kitchen printer (`lpstat -p` lists queues). Unset ⇒ orders are marked "no printer" and tickets are printed from the browser via the kitchen PDF |
| `RESTAURANT_NAME` | `FoodDesk` | Header on the customer receipt |
| `PDF_LANG` | `it` | Language of receipt/ticket labels (`it` or `en`); `it` also formats money as `28,00` |
| `CURRENCY_SYMBOL` | `€` | Currency symbol on receipts and totals |
| `SERVICE_DAY_CUTOFF_HOUR` | `5` | Orders before this hour count as the previous service day |

## Design notes

- **Money is integer cents.** No floats anywhere in the money path.
- **Order items snapshot** product name, price and category, so editing the menu
  tomorrow never rewrites tonight's receipts.
- **Deletes are soft** (`active = false`) so historical orders keep resolving.
- **Authorization is server-side** on every route (`src/auth/acl.ts`). The UI hiding
  admin screens is cosmetic; `test/acl.test.ts` is the actual contract.
- **Passwords use Node's built-in scrypt** — no native module to compile on the server.
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

## Deploying

See [deploy/README.md](deploy/README.md) — on the Debian server it is one command:
`sudo deploy/install.sh`.
