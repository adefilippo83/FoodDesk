import { eq, ne } from 'drizzle-orm'
import { hashPassword } from '../auth/password.js'
import { serviceDayOf } from '../lib/serviceDay.js'
import type { Db } from './index.js'
import { categories, orderItems, orders, sessions, settings, products, users } from './schema.js'

/**
 * Demo dataset for the public demo instance: wipes everything except the
 * admin account and rebuilds a lively sagra evening — menu, staff, settings
 * and a service day in progress (open, partially cooked, completed and
 * cancelled orders). Deterministic and safe to re-run.
 *
 * Two callers: the seed-demo CLI (a fresh process, for local use) and the
 * demo reset endpoint, which runs it INSIDE the live server. The endpoint
 * exists because the old way — SSH into the 256 MB demo machine and start
 * a second Node process — got the live server OOM-killed.
 *
 * The wipe and the rebuild are one transaction: a reset that dies halfway
 * (a kill, a crash) leaves the previous dataset in place, never an empty
 * demo, so retrying is always safe. The password hashes are computed first —
 * scrypt is async and a better-sqlite3 transaction is synchronous.
 */

export const DEMO_PASSWORD = 'fooddesk-demo'

const COVER_CENTS = 250

const MENU: Array<[string, Array<[string, number]>]> = [
  ['Antipasti', [['Bruschetta', 400], ['Tagliere misto', 850]]],
  ['Primi', [['Pappardelle al cinghiale', 900], ['Gnocchi al pomodoro', 750], ['Polenta e funghi', 800]]],
  ['Secondi', [['Porchetta', 1000], ['Salsicce alla griglia', 850], ['Formaggio alla piastra', 700]]],
  ['Panini', [['Panino con porchetta', 650], ['Panino con salsiccia', 600]]],
  ['Contorni', [['Patatine fritte', 350], ['Verdure grigliate', 400], ['Fagioli all’uccelletto', 400]]],
  ['Dolci', [['Tiramisù', 450], ['Cantucci e vin santo', 500]]],
  ['Bevande', [['Acqua', 100], ['Coca-Cola', 250], ['Birra media', 450], ['Vino rosso (calice)', 300], ['Caffè', 100]]],
]

type DemoItem = { p: string; qty: number; note?: string; done?: boolean }
type DemoOrder = {
  customer: string
  minAgo: number
  /** Staff username, or null for a customer self-order (no staff author). */
  by: 'mario' | 'lucia' | null
  covers: number
  note?: string
  /** How it was paid at the register; a self-order waits to be paid at pickup. */
  payment?: 'cash' | 'pos'
  completed?: boolean
  cancelled?: boolean
  /** Fixed token so the demo status page has a stable URL. */
  publicToken?: string
  items: DemoItem[]
}

const EVENING: DemoOrder[] = [
  {
    customer: 'Rossi', minAgo: 35, by: 'mario', covers: 2, payment: 'cash', completed: true,
    items: [
      { p: 'Pappardelle al cinghiale', qty: 2, done: true },
      { p: 'Porchetta', qty: 1, done: true },
      { p: 'Birra media', qty: 2, done: true },
    ],
  },
  {
    customer: 'Bianchi', minAgo: 24, by: 'lucia', covers: 4, payment: 'pos',
    items: [
      { p: 'Tagliere misto', qty: 1, done: true },
      { p: 'Gnocchi al pomodoro', qty: 2, done: true },
      { p: 'Salsicce alla griglia', qty: 2 },
      { p: 'Patatine fritte', qty: 2 },
      { p: 'Vino rosso (calice)', qty: 4, done: true },
    ],
  },
  {
    customer: 'Verdi', minAgo: 16, by: 'mario', covers: 0, payment: 'cash',
    items: [
      { p: 'Panino con porchetta', qty: 2 },
      { p: 'Coca-Cola', qty: 2, done: true },
    ],
  },
  {
    customer: 'Neri', minAgo: 11, by: 'lucia', covers: 3, payment: 'pos', note: 'tavolo vicino al palco',
    items: [
      { p: 'Polenta e funghi', qty: 1, note: 'senza parmigiano' },
      { p: 'Porchetta', qty: 2 },
      { p: 'Verdure grigliate', qty: 1 },
      { p: 'Acqua', qty: 2, done: true },
    ],
  },
  {
    customer: 'Gallo', minAgo: 8, by: 'mario', covers: 2, payment: 'cash', cancelled: true,
    items: [{ p: 'Formaggio alla piastra', qty: 2 }],
  },
  {
    customer: 'Ferri', minAgo: 3, by: 'lucia', covers: 2, payment: 'cash',
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

export type DemoSeedResult = {
  categories: number
  products: number
  orders: number
  serviceDay: string
}

export async function seedDemo(db: Db): Promise<DemoSeedResult> {
  // Async work first (see above). The admin's hash is only needed when the
  // account does not exist — the Docker entrypoint normally creates it, and
  // an existing admin keeps its password.
  const staffHash = await hashPassword(DEMO_PASSWORD)
  const hasAdmin = db.select({ id: users.id }).from(users).limit(1).get() !== undefined
  const adminHash = hasAdmin ? null : await hashPassword(process.env.ADMIN_PASSWORD ?? DEMO_PASSWORD)

  const now = Math.floor(Date.now() / 1000)
  const serviceDay = serviceDayOf()

  return db.transaction((tx) => {
    // ---- wipe, in foreign-key order; every session is evicted on purpose ----
    tx.delete(orderItems).run()
    tx.delete(orders).run()
    tx.delete(sessions).run()
    tx.delete(products).run()
    tx.delete(categories).run()
    tx.delete(settings).run()
    tx.delete(users).where(ne(users.username, 'admin')).run()

    // ---- users: keep the existing admin (and its password) untouched ----
    let admin = tx.select().from(users).limit(1).get()
    if (!admin) {
      admin = tx
        .insert(users)
        .values({
          username: 'admin',
          passwordHash: adminHash ?? staffHash,
          displayName: 'Administrator',
          role: 'admin',
        })
        .returning()
        .get()
    }

    const staff = tx
      .insert(users)
      .values([
        { username: 'giulia', passwordHash: staffHash, displayName: 'Giulia', role: 'maitre' },
        { username: 'mario', passwordHash: staffHash, displayName: 'Mario', role: 'operator' },
        { username: 'lucia', passwordHash: staffHash, displayName: 'Lucia', role: 'operator' },
        { username: 'cucina', passwordHash: staffHash, displayName: 'Cucina', role: 'kitchen' },
      ])
      .returning()
      .all()
    const staffId = new Map(staff.map((u) => [u.username, u.id]))

    // ---- settings ----
    tx.insert(settings)
      .values([
        { key: 'restaurantName', value: 'Sagra del Borgo (demo)' },
        { key: 'coverChargeCents', value: String(COVER_CENTS) },
        { key: 'orderHeaderText', value: 'Sagra del Borgo\nPro Loco — demo' },
        { key: 'orderFooterText', value: 'Ritira al banco con questo foglio' },
        { key: 'orderDisclaimer', value: 'Documento non fiscale — dati dimostrativi' },
        { key: 'orderCategoryStyle', value: 'alternating' },
        // The demo showcases customer self-ordering: /order is always open.
        { key: 'customerOrdering', value: 'on' },
      ])
      .run()

    // ---- menu ----
    const byName = new Map<string, { id: number; priceCents: number; category: string }>()
    for (const [catIndex, [catName, items]] of MENU.entries()) {
      const cat = tx.insert(categories).values({ name: catName, sortOrder: catIndex }).returning().get()
      for (const [prodIndex, [prodName, priceCents]] of items.entries()) {
        const prod = tx
          .insert(products)
          .values({ categoryId: cat.id, name: prodName, priceCents, sortOrder: prodIndex })
          .returning()
          .get()
        byName.set(prodName, { id: prod.id, priceCents, category: catName })
      }
    }

    // ---- a service evening in progress ----
    for (const [index, o] of EVENING.entries()) {
      const createdAt = now - o.minAgo * 60
      const totalCents =
        o.items.reduce((sum, i) => sum + byName.get(i.p)!.priceCents * i.qty, 0) +
        o.covers * COVER_CENTS
      const order = tx
        .insert(orders)
        .values({
          dailyNumber: index + 1,
          serviceDay,
          customerName: o.customer,
          covers: o.covers,
          coverChargeCents: COVER_CENTS,
          note: o.note ?? null,
          totalCents,
          createdBy: o.by === null ? null : staffId.get(o.by)!,
          origin: o.by === null ? 'customer' : 'staff',
          publicToken: o.publicToken ?? null,
          // A staff order is paid as it is taken (cash or POS, from 0.2.9).
          paymentMethod: o.payment ?? null,
          paidAt: o.payment ? createdAt : null,
          createdAt,
          printError: 'printer_not_configured',
          cancelledAt: o.cancelled ? createdAt + 120 : null,
          cancelledBy: o.cancelled ? admin.id : null,
          completedAt: o.completed ? createdAt + 15 * 60 : null,
        })
        .returning()
        .get()
      for (const item of o.items) {
        const p = byName.get(item.p)!
        tx.insert(orderItems)
          .values({
            orderId: order.id,
            productId: p.id,
            nameSnapshot: item.p,
            priceCentsSnapshot: p.priceCents,
            categoryNameSnapshot: p.category,
            qty: item.qty,
            note: item.note ?? null,
            doneAt: o.completed || item.done ? createdAt + 10 * 60 : null,
          })
          .run()
      }
    }

    // A couple of stock-tracked products so the demo shows the feature.
    for (const [name, stockRemaining] of [['Porchetta', 15], ['Tiramisù', 8]] as const) {
      tx.update(products)
        .set({ stockRemaining })
        .where(eq(products.id, byName.get(name)!.id))
        .run()
    }

    return {
      categories: MENU.length,
      products: byName.size,
      orders: EVENING.length,
      serviceDay,
    }
  })
}
