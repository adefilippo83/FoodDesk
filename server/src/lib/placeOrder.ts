import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import {
  categories,
  orderItems,
  orders,
  products,
  type Order,
  type OrderItem,
} from '../db/schema.js'
import { serviceDayOf } from './serviceDay.js'

/**
 * The one way an order comes into existence — shared by the staff route and
 * the public self-ordering route, so both get identical guarantees: prices
 * from the database, atomic stock accounting, per-day numbering, and
 * idempotent retries via clientKey.
 */

export type IncomingItem = { productId: number; qty: number; note?: string }

export function parseItems(raw: unknown): IncomingItem[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'items_required' }
  if (raw.length > 100) return { error: 'too_many_items' }

  const items: IncomingItem[] = []
  for (const entry of raw) {
    const e = entry as Record<string, unknown>
    const productId = Number(e?.productId)
    const qty = Number(e?.qty)
    if (!Number.isInteger(productId) || productId <= 0) return { error: 'invalid_product_id' }
    if (!Number.isInteger(qty) || qty <= 0 || qty > 99) return { error: 'invalid_qty' }
    const note = typeof e?.note === 'string' && e.note.trim() ? e.note.trim().slice(0, 200) : undefined
    items.push({ productId, qty, note })
  }
  return items
}

export type PlaceOrderInput = {
  items: IncomingItem[]
  customerName: string
  covers: number
  coverChargeCents: number
  note: string | null
  clientKey: string | null
  /** null for customer self-ordering — there is no staff author. */
  createdBy: number | null
  origin: 'staff' | 'customer'
  publicToken: string | null
  /** Online payments (phase B): stamped at creation, order held until paid. */
  paymentMethod?: 'stripe' | 'paypal' | null
}

export type PlaceOrderResult =
  | { ok: true; order: Order; items: OrderItem[]; replayed: boolean }
  | {
      ok: false
      code: 'unknown_products' | 'products_unavailable' | 'out_of_stock' | 'payload_mismatch'
      ids: number[]
    }

/** Canonical signature of what an order is FOR: which products, how many,
 *  how many covers, whose name — order-insensitive across the item list. */
function orderSignature(
  items: { productId: number; qty: number }[],
  covers: number,
  customerName: string,
): string {
  const lines = items
    .map((i) => `${i.productId}x${i.qty}`)
    .sort()
    .join(',')
  return `${lines}|${covers}|${customerName}`
}

export async function placeOrder(db: Db, input: PlaceOrderInput): Promise<PlaceOrderResult> {
  // Idempotency: a retry of a submission that actually landed (flaky venue
  // Wi-Fi) must return the original order, never create a twin.
  const replayOf = async (): Promise<PlaceOrderResult | null> => {
    const existing = (
      await db.select().from(orders).where(eq(orders.clientKey, input.clientKey!)).limit(1)
    )[0]
    if (!existing) return null
    const existingItems = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, existing.id))
    // The key identifies a submission, not a blank cheque: a retry that
    // changed the cart (a waiter added a line after a flaky-network timeout)
    // must NOT silently return the original order and lose the change.
    const submitted = orderSignature(input.items, input.covers, input.customerName)
    const stored = orderSignature(existingItems, existing.covers, existing.customerName ?? '')
    if (submitted !== stored) return { ok: false, code: 'payload_mismatch', ids: [] }
    return { ok: true, order: existing, items: existingItems, replayed: true }
  }
  if (input.clientKey) {
    const replay = await replayOf()
    if (replay) return replay
  }

  // Prices come from the database, never from the client. A tampered
  // payload cannot discount anything.
  const ids = [...new Set(input.items.map((i) => i.productId))]
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      priceCents: products.priceCents,
      active: products.active,
      stockRemaining: products.stockRemaining,
      categoryName: categories.name,
    })
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(inArray(products.id, ids))

  const byId = new Map(rows.map((r) => [r.id, r]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) return { ok: false, code: 'unknown_products', ids: missing }

  const inactive = ids.filter((id) => !byId.get(id)!.active)
  if (inactive.length) return { ok: false, code: 'products_unavailable', ids: inactive }

  // Stock-tracked products must cover the requested quantities. This is
  // the friendly pre-check; the transaction below re-verifies atomically.
  const short = input.items.filter((i) => {
    const p = byId.get(i.productId)!
    return p.stockRemaining !== null && p.stockRemaining < i.qty
  })
  if (short.length) {
    return { ok: false, code: 'out_of_stock', ids: short.map((i) => i.productId) }
  }

  const serviceDay = serviceDayOf()
  let created: Order
  try {
    created = db.transaction((tx) => {
      // Per-day sequence, allocated inside the transaction so two submitters
      // racing cannot land on the same ticket number.
      const last = tx
        .select({ max: sql<number | null>`max(${orders.dailyNumber})` })
        .from(orders)
        .where(eq(orders.serviceDay, serviceDay))
        .get()
      const dailyNumber = (last?.max ?? 0) + 1

      const totalCents =
        input.items.reduce((sum, i) => sum + byId.get(i.productId)!.priceCents * i.qty, 0) +
        input.covers * input.coverChargeCents

      const order = tx
        .insert(orders)
        .values({
          dailyNumber,
          serviceDay,
          customerName: input.customerName,
          covers: input.covers,
          coverChargeCents: input.coverChargeCents,
          note: input.note,
          totalCents,
          createdBy: input.createdBy,
          origin: input.origin,
          publicToken: input.publicToken,
          paymentMethod: input.paymentMethod ?? null,
          clientKey: input.clientKey,
        })
        .returning()
        .get()

      for (const item of input.items) {
        const p = byId.get(item.productId)!
        tx.insert(orderItems)
          .values({
            orderId: order.id,
            productId: p.id,
            nameSnapshot: p.name,
            priceCentsSnapshot: p.priceCents,
            categoryNameSnapshot: p.categoryName,
            qty: item.qty,
            note: item.note ?? null,
          })
          .run()
        // Stock: the conditional update is the race guard — two submitters
        // grabbing the last portions cannot both win. At zero the product
        // takes itself off the menu (issue #31).
        if (p.stockRemaining !== null) {
          const res = tx
            .update(products)
            .set({ stockRemaining: sql`${products.stockRemaining} - ${item.qty}` })
            .where(
              and(
                eq(products.id, p.id),
                isNotNull(products.stockRemaining),
                gte(products.stockRemaining, item.qty),
              ),
            )
            .run()
          if (res.changes === 0) throw new Error('OUT_OF_STOCK')
          tx.update(products)
            .set({ active: false })
            .where(and(eq(products.id, p.id), lte(products.stockRemaining, 0)))
            .run()
        }
      }
      return order
    })
  } catch (err) {
    // Two identical submissions racing: the loser of the unique-index race
    // replays the winner's order.
    if (input.clientKey && err instanceof Error && err.message.includes('UNIQUE')) {
      const replay = await replayOf()
      if (replay) return replay
    }
    // Lost the race for the last portions: the transaction rolled back.
    if (err instanceof Error && err.message === 'OUT_OF_STOCK') {
      return { ok: false, code: 'out_of_stock', ids }
    }
    throw err
  }

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, created.id))
  return { ok: true, order: created, items, replayed: false }
}
