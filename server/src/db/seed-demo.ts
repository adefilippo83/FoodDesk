import { eq, ne } from 'drizzle-orm'
import { hashPassword } from '../auth/password.js'
import { serviceDayOf } from '../lib/serviceDay.js'
import { createDb } from './index.js'
import { categories, orderItems, orders, sessions, settings, products, users } from './schema.js'

/**
 * Demo dataset for the public demo instance: wipes everything except the
 * admin account and rebuilds a lively sagra evening — menu, staff, settings
 * and a service day in progress (open, partially cooked, completed and
 * cancelled orders). Deterministic and safe to re-run: the scheduled demo
 * reset executes exactly this script.
 */

const COVER_CENTS = 250

const file = process.env.DATABASE_FILE ?? './data/fooddesk.db'
const { db, sqlite } = createDb(file)
const now = Math.floor(Date.now() / 1000)

// ---- wipe, in foreign-key order; every session is evicted on purpose ----
await db.delete(orderItems)
await db.delete(orders)
await db.delete(sessions)
await db.delete(products)
await db.delete(categories)
await db.delete(settings)
await db.delete(users).where(ne(users.username, 'admin'))

// ---- users: keep the existing admin (and its password) untouched ----
let admin = (await db.select().from(users).limit(1))[0]
if (!admin) {
  admin = (
    await db
      .insert(users)
      .values({
        username: 'admin',
        passwordHash: await hashPassword(process.env.ADMIN_PASSWORD ?? 'fooddesk-demo'),
        displayName: 'Administrator',
        role: 'admin',
      })
      .returning()
  )[0]!
}

const staffPassword = await hashPassword('fooddesk-demo')
const staff = await db
  .insert(users)
  .values([
    { username: 'giulia', passwordHash: staffPassword, displayName: 'Giulia', role: 'maitre' },
    { username: 'mario', passwordHash: staffPassword, displayName: 'Mario', role: 'operator' },
    { username: 'lucia', passwordHash: staffPassword, displayName: 'Lucia', role: 'operator' },
    { username: 'cucina', passwordHash: staffPassword, displayName: 'Cucina', role: 'kitchen' },
  ])
  .returning()
const mario = staff.find((u) => u.username === 'mario')!
const lucia = staff.find((u) => u.username === 'lucia')!

// ---- settings ----
await db.insert(settings).values([
  { key: 'restaurantName', value: 'Sagra del Borgo (demo)' },
  { key: 'coverChargeCents', value: String(COVER_CENTS) },
  { key: 'orderHeaderText', value: 'Sagra del Borgo\nPro Loco — demo' },
  { key: 'orderFooterText', value: 'Ritira al banco con questo foglio' },
  { key: 'orderDisclaimer', value: 'Documento non fiscale — dati dimostrativi' },
  { key: 'orderCategoryStyle', value: 'alternating' },
  // The demo showcases customer self-ordering: /order is always open.
  { key: 'customerOrdering', value: 'on' },
])

// ---- menu ----
const MENU: Array<[string, Array<[string, number]>]> = [
  ['Antipasti', [['Bruschetta', 400], ['Tagliere misto', 850]]],
  ['Primi', [['Pappardelle al cinghiale', 900], ['Gnocchi al pomodoro', 750], ['Polenta e funghi', 800]]],
  ['Secondi', [['Porchetta', 1000], ['Salsicce alla griglia', 850], ['Formaggio alla piastra', 700]]],
  ['Panini', [['Panino con porchetta', 650], ['Panino con salsiccia', 600]]],
  ['Contorni', [['Patatine fritte', 350], ['Verdure grigliate', 400], ['Fagioli all’uccelletto', 400]]],
  ['Dolci', [['Tiramisù', 450], ['Cantucci e vin santo', 500]]],
  ['Bevande', [['Acqua', 100], ['Coca-Cola', 250], ['Birra media', 450], ['Vino rosso (calice)', 300], ['Caffè', 100]]],
]

const byName = new Map<string, { id: number; priceCents: number; category: string }>()
for (const [catIndex, [catName, items]] of MENU.entries()) {
  const cat = (
    await db.insert(categories).values({ name: catName, sortOrder: catIndex }).returning()
  )[0]!
  for (const [prodIndex, [prodName, priceCents]] of items.entries()) {
    const prod = (
      await db
        .insert(products)
        .values({ categoryId: cat.id, name: prodName, priceCents, sortOrder: prodIndex })
        .returning()
    )[0]!
    byName.set(prodName, { id: prod.id, priceCents, category: catName })
  }
}

// ---- a service evening in progress ----
type DemoItem = { p: string; qty: number; note?: string; done?: boolean }
const EVENING: Array<{
  customer: string
  minAgo: number
  /** null = customer self-order (no staff author). */
  by: number | null
  covers: number
  note?: string
  completed?: boolean
  cancelled?: boolean
  /** Fixed token so the demo status page has a stable URL. */
  publicToken?: string
  items: DemoItem[]
}> = [
  {
    customer: 'Rossi', minAgo: 35, by: mario.id, covers: 2, completed: true,
    items: [
      { p: 'Pappardelle al cinghiale', qty: 2, done: true },
      { p: 'Porchetta', qty: 1, done: true },
      { p: 'Birra media', qty: 2, done: true },
    ],
  },
  {
    customer: 'Bianchi', minAgo: 24, by: lucia.id, covers: 4,
    items: [
      { p: 'Tagliere misto', qty: 1, done: true },
      { p: 'Gnocchi al pomodoro', qty: 2, done: true },
      { p: 'Salsicce alla griglia', qty: 2 },
      { p: 'Patatine fritte', qty: 2 },
      { p: 'Vino rosso (calice)', qty: 4, done: true },
    ],
  },
  {
    customer: 'Verdi', minAgo: 16, by: mario.id, covers: 0,
    items: [
      { p: 'Panino con porchetta', qty: 2 },
      { p: 'Coca-Cola', qty: 2, done: true },
    ],
  },
  {
    customer: 'Neri', minAgo: 11, by: lucia.id, covers: 3, note: 'tavolo vicino al palco',
    items: [
      { p: 'Polenta e funghi', qty: 1, note: 'senza parmigiano' },
      { p: 'Porchetta', qty: 2 },
      { p: 'Verdure grigliate', qty: 1 },
      { p: 'Acqua', qty: 2, done: true },
    ],
  },
  {
    customer: 'Gallo', minAgo: 8, by: mario.id, covers: 2, cancelled: true,
    items: [{ p: 'Formaggio alla piastra', qty: 2 }],
  },
  {
    customer: 'Ferri', minAgo: 3, by: lucia.id, covers: 2,
    items: [
      { p: 'Bruschetta', qty: 2 },
      { p: 'Pappardelle al cinghiale', qty: 1 },
      { p: 'Tiramisù', qty: 2 },
      { p: 'Birra media', qty: 1 },
    ],
  },
  // A customer self-order (phase A): no staff author, still to be paid at
  // pickup — shows the Customer badge in Orders and on the kitchen display.
  {
    customer: 'Tavolo 5 — Colombo', minAgo: 2, by: null, covers: 2,
    publicToken: 'demo-customer-token-0001',
    items: [
      { p: 'Panino con salsiccia', qty: 2 },
      { p: 'Coca-Cola', qty: 2 },
    ],
  },
]

const serviceDay = serviceDayOf()
for (const [index, o] of EVENING.entries()) {
  const createdAt = now - o.minAgo * 60
  const totalCents =
    o.items.reduce((sum, i) => sum + byName.get(i.p)!.priceCents * i.qty, 0) +
    o.covers * COVER_CENTS
  const order = (
    await db
      .insert(orders)
      .values({
        dailyNumber: index + 1,
        serviceDay,
        customerName: o.customer,
        covers: o.covers,
        coverChargeCents: COVER_CENTS,
        note: o.note ?? null,
        totalCents,
        createdBy: o.by,
        origin: o.by === null ? 'customer' : 'staff',
        publicToken: o.publicToken ?? null,
        createdAt,
        printError: 'printer_not_configured',
        cancelledAt: o.cancelled ? createdAt + 120 : null,
        cancelledBy: o.cancelled ? admin.id : null,
        completedAt: o.completed ? createdAt + 15 * 60 : null,
      })
      .returning()
  )[0]!
  for (const item of o.items) {
    const p = byName.get(item.p)!
    await db.insert(orderItems).values({
      orderId: order.id,
      productId: p.id,
      nameSnapshot: item.p,
      priceCentsSnapshot: p.priceCents,
      categoryNameSnapshot: p.category,
      qty: item.qty,
      note: item.note ?? null,
      doneAt: o.completed || item.done ? createdAt + 10 * 60 : null,
    })
  }
}

// A couple of stock-tracked products so the demo shows the feature.
await db
  .update(products)
  .set({ stockRemaining: 15 })
  .where(eq(products.id, byName.get('Porchetta')!.id))
await db
  .update(products)
  .set({ stockRemaining: 8 })
  .where(eq(products.id, byName.get('Tiramisù')!.id))

console.log(
  `demo data ready: ${MENU.length} categories, ${byName.size} products, ` +
    `${EVENING.length} orders on ${serviceDay}, staff giulia/mario/lucia/cucina (password: fooddesk-demo)`,
)
sqlite.close()
