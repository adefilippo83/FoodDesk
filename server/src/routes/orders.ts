import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { FastifyInstance } from 'fastify'
import { isManager, requireFloorStaff, requireManager } from '../auth/acl.js'
import type { Db } from '../db/index.js'
import { categories, orderItems, orders, products, users, type Order } from '../db/schema.js'
import { notifyOrdersChanged } from '../lib/events.js'
import { isServiceDay, serviceDayOf } from '../lib/serviceDay.js'
import { renderKitchenTicket, renderOrderSheet, renderReceipt } from '../print/pdf.js'
import { kitchenQueue, printKitchenTicket } from '../print/service.js'
import { loadSettings } from '../settings.js'

type IncomingItem = { productId: number; qty: number; note?: string }

function parseItems(raw: unknown): IncomingItem[] | { error: string } {
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

export function orderRoutes(db: Db) {
  return async function register(app: FastifyInstance) {
    // Floor staff only: a kitchen account has no business creating or
    // browsing orders outside its display.
    app.addHook('preHandler', requireFloorStaff)

    /** Both roles may take orders — that is the operator's whole job. */
    app.post('/api/orders', async (req, reply) => {
      const body = req.body as Record<string, unknown> | undefined
      const parsed = parseItems(body?.items)
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error })

      const customerName =
        typeof body?.customerName === 'string' && body.customerName.trim()
          ? body.customerName.trim().slice(0, 60)
          : null
      if (!customerName) return reply.code(400).send({ error: 'customer_name_required' })

      // Coperto: people at the table. 0 is legitimate (bar/takeaway order).
      const covers = body?.covers === undefined ? 1 : Number(body.covers)
      if (!Number.isInteger(covers) || covers < 0 || covers > 99) {
        return reply.code(400).send({ error: 'invalid_covers' })
      }

      const note =
        typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null

      // Idempotency: a retry of a submission that actually landed (flaky
      // venue Wi-Fi) must return the original order, never create a twin.
      const clientKey =
        typeof body?.clientKey === 'string' && body.clientKey.trim()
          ? body.clientKey.trim().slice(0, 64)
          : null
      const replayOf = async () => {
        const existing = (
          await db.select().from(orders).where(eq(orders.clientKey, clientKey!)).limit(1)
        )[0]
        if (!existing) return null
        const existingItems = await db
          .select()
          .from(orderItems)
          .where(eq(orderItems.orderId, existing.id))
        return { ...existing, items: existingItems }
      }
      if (clientKey) {
        const replay = await replayOf()
        if (replay) return reply.code(200).send(replay)
      }

      // Prices come from the database, never from the client. A tampered
      // payload cannot discount anything.
      const ids = [...new Set(parsed.map((i) => i.productId))]
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
      if (missing.length) return reply.code(400).send({ error: 'unknown_products', missing })

      const inactive = ids.filter((id) => !byId.get(id)!.active)
      if (inactive.length) {
        return reply.code(409).send({ error: 'products_unavailable', unavailable: inactive })
      }

      // Stock-tracked products must cover the requested quantities. This is
      // the friendly pre-check; the transaction below re-verifies atomically.
      const short = parsed.filter((i) => {
        const p = byId.get(i.productId)!
        return p.stockRemaining !== null && p.stockRemaining < i.qty
      })
      if (short.length) {
        return reply
          .code(409)
          .send({ error: 'out_of_stock', unavailable: short.map((i) => i.productId) })
      }

      const serviceDay = serviceDayOf()
      const userId = req.user!.id
      // Snapshot the coperto amount now: changing it in settings tomorrow
      // must not change tonight's bills.
      const { coverChargeCents } = await loadSettings(db)

      let created
      try {
        created = db.transaction((tx) => {
          // Per-day sequence, allocated inside the transaction so two waiters
          // submitting at once cannot land on the same ticket number.
          const last = tx
            .select({ max: sql<number | null>`max(${orders.dailyNumber})` })
            .from(orders)
            .where(eq(orders.serviceDay, serviceDay))
            .get()
          const dailyNumber = (last?.max ?? 0) + 1

          const totalCents =
            parsed.reduce((sum, i) => sum + byId.get(i.productId)!.priceCents * i.qty, 0) +
            covers * coverChargeCents

          const order = tx
            .insert(orders)
            .values({
              dailyNumber,
              serviceDay,
              customerName,
              covers,
              coverChargeCents,
              note,
              totalCents,
              createdBy: userId,
              clientKey,
            })
            .returning()
            .get()

          for (const item of parsed) {
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
            // Stock: the conditional update is the race guard — two waiters
            // grabbing the last portions cannot both win. At zero the
            // product takes itself off the menu (issue #31).
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
        // Two identical submissions racing: the loser of the unique-index
        // race replays the winner's order.
        if (clientKey && err instanceof Error && err.message.includes('UNIQUE')) {
          const replay = await replayOf()
          if (replay) return reply.code(200).send(replay)
        }
        // Lost the race for the last portions: the transaction rolled back.
        if (err instanceof Error && err.message === 'OUT_OF_STOCK') {
          return reply.code(409).send({ error: 'out_of_stock', unavailable: ids })
        }
        throw err
      }

      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, created.id))

      // Print in the background: the waiter gets their confirmation now, and a
      // slow or jammed printer shows up as printError on the order instead.
      printKitchenTicket(db, created).catch((err) => req.log.error(err, 'kitchen print crashed'))

      notifyOrdersChanged()
      return reply.code(201).send({ ...created, items })
    })

    /** Loads an order enforcing the same visibility rule everywhere. */
    async function loadVisibleOrder(
      id: number,
      user: { id: number; role: string },
    ): Promise<Order | 'not_found' | 'forbidden'> {
      const order = (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0]
      if (!order) return 'not_found'
      if (!isManager(user) && order.createdBy !== user.id) return 'forbidden'
      return order
    }

    for (const kind of ['receipt', 'kitchen', 'order'] as const) {
      app.get(`/api/orders/:id/${kind}.pdf`, async (req, reply) => {
        const id = Number((req.params as { id: string }).id)
        const order = await loadVisibleOrder(id, req.user!)
        if (order === 'not_found') return reply.code(404).send({ error: 'not_found' })
        if (order === 'forbidden') return reply.code(403).send({ error: 'forbidden' })

        const items = await db.select().from(orderItems).where(eq(orderItems.orderId, id))
        const s = await loadSettings(db)
        const pdf =
          kind === 'receipt'
            ? await renderReceipt(order, items, s)
            : kind === 'kitchen'
              ? await renderKitchenTicket(order, items, s)
              : await renderOrderSheet(order, items, s)

        return reply
          .header('content-type', 'application/pdf')
          .header(
            'content-disposition',
            `inline; filename="order-${order.serviceDay}-${String(order.dailyNumber).padStart(3, '0')}-${kind}.pdf"`,
          )
          .send(pdf)
      })
    }

    /**
     * Cancel, never delete: the row and its daily number survive for the
     * records; report totals simply skip it.
     */
    app.post('/api/orders/:id/cancel', { preHandler: requireManager }, async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const order = (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0]
      if (!order) return reply.code(404).send({ error: 'not_found' })
      if (order.cancelledAt) return { ...order } // idempotent

      const updated = (
        await db
          .update(orders)
          .set({ cancelledAt: Math.floor(Date.now() / 1000), cancelledBy: req.user!.id })
          .where(eq(orders.id, id))
          .returning()
      )[0]!
      req.log.info(
        {
          event: 'order_cancelled',
          by: req.user!.id,
          orderId: id,
          dailyNumber: updated.dailyNumber,
          totalCents: updated.totalCents,
        },
        'audit',
      )
      notifyOrdersChanged()
      return updated
    })

    /**
     * Cancel a single line: admin and maître anywhere, a waiter on their own
     * orders (fixing a mis-tap). Audited soft-cancel, total recomputed; when
     * the last active line goes, the whole order is cancelled with it.
     */
    app.post('/api/orders/:id/items/:itemId/cancel', async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const itemId = Number((req.params as { itemId: string }).itemId)
      const order = await loadVisibleOrder(id, req.user!)
      if (order === 'not_found') return reply.code(404).send({ error: 'not_found' })
      if (order === 'forbidden') return reply.code(403).send({ error: 'forbidden' })
      if (order.cancelledAt) return reply.code(409).send({ error: 'order_cancelled' })

      const item = (
        await db.select().from(orderItems).where(eq(orderItems.id, itemId)).limit(1)
      )[0]
      if (!item || item.orderId !== id) return reply.code(404).send({ error: 'not_found' })

      const now = Math.floor(Date.now() / 1000)
      const result = db.transaction((tx) => {
        if (!item.cancelledAt) {
          tx.update(orderItems)
            .set({ cancelledAt: now, cancelledBy: req.user!.id })
            .where(eq(orderItems.id, itemId))
            .run()
          // Stock-tracked products get the portions back; one that had sold
          // out through this very line returns to the menu.
          tx.update(products)
            .set({ stockRemaining: sql`${products.stockRemaining} + ${item.qty}` })
            .where(and(eq(products.id, item.productId), isNotNull(products.stockRemaining)))
            .run()
          tx.update(products)
            .set({ active: true })
            .where(
              and(
                eq(products.id, item.productId),
                eq(products.active, false),
                eq(products.stockRemaining, item.qty),
              ),
            )
            .run()
        }
        const all = tx.select().from(orderItems).where(eq(orderItems.orderId, id)).all()
        const active = all.filter((i) => i.cancelledAt === null)

        const totalCents =
          active.reduce((sum, i) => sum + i.priceCentsSnapshot * i.qty, 0) +
          order.covers * order.coverChargeCents
        const orderCancelled = active.length === 0
        const completedAt =
          !orderCancelled && active.every((i) => i.doneAt !== null)
            ? (order.completedAt ?? now)
            : null

        const updated = tx
          .update(orders)
          .set({
            totalCents,
            completedAt,
            ...(orderCancelled ? { cancelledAt: now, cancelledBy: req.user!.id } : {}),
          })
          .where(eq(orders.id, id))
          .returning()
          .get()!
        return { updated, items: all, orderCancelled }
      })

      req.log.info(
        {
          event: 'order_item_cancelled',
          by: req.user!.id,
          orderId: id,
          itemId,
          orderCancelled: result.orderCancelled,
          totalCents: result.updated.totalCents,
        },
        'audit',
      )
      notifyOrdersChanged()
      return { ...result.updated, items: result.items }
    })

    /**
     * Change a line's quantity in either direction (issue #30 + follow-up).
     * Same visibility rules as line cancellation. An increase behaves like a
     * fresh order for the delta — the product must still be active and its
     * stock must cover it — and sends the line back to the kitchen as
     * pending. Dropping to zero is expressed as cancelling the line instead.
     */
    app.post('/api/orders/:id/items/:itemId/quantity', async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const itemId = Number((req.params as { itemId: string }).itemId)
      const qty = Number((req.body as { qty?: unknown } | undefined)?.qty)
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
        return reply.code(400).send({ error: 'invalid_qty' })
      }

      const order = await loadVisibleOrder(id, req.user!)
      if (order === 'not_found') return reply.code(404).send({ error: 'not_found' })
      if (order === 'forbidden') return reply.code(403).send({ error: 'forbidden' })
      if (order.cancelledAt) return reply.code(409).send({ error: 'order_cancelled' })

      const item = (
        await db.select().from(orderItems).where(eq(orderItems.id, itemId)).limit(1)
      )[0]
      if (!item || item.orderId !== id) return reply.code(404).send({ error: 'not_found' })
      if (item.cancelledAt) return reply.code(409).send({ error: 'item_cancelled' })
      if (qty === item.qty) return reply.code(400).send({ error: 'nothing_to_update' })

      const delta = qty - item.qty
      const now = Math.floor(Date.now() / 1000)
      let result
      try {
        result = db.transaction((tx) => {
          if (delta > 0) {
            const product = tx
              .select()
              .from(products)
              .where(eq(products.id, item.productId))
              .get()
            if (!product || !product.active) throw new Error('PRODUCT_UNAVAILABLE')
            if (product.stockRemaining !== null) {
              const res = tx
                .update(products)
                .set({ stockRemaining: sql`${products.stockRemaining} - ${delta}` })
                .where(
                  and(
                    eq(products.id, item.productId),
                    isNotNull(products.stockRemaining),
                    gte(products.stockRemaining, delta),
                  ),
                )
                .run()
              if (res.changes === 0) throw new Error('OUT_OF_STOCK')
              tx.update(products)
                .set({ active: false })
                .where(and(eq(products.id, item.productId), lte(products.stockRemaining, 0)))
                .run()
            }
          } else {
            const back = -delta
            tx.update(products)
              .set({ stockRemaining: sql`${products.stockRemaining} + ${back}` })
              .where(and(eq(products.id, item.productId), isNotNull(products.stockRemaining)))
              .run()
            tx.update(products)
              .set({ active: true })
              .where(
                and(
                  eq(products.id, item.productId),
                  eq(products.active, false),
                  eq(products.stockRemaining, back),
                ),
              )
              .run()
          }

          // More portions to cook → the line goes back to pending.
          tx.update(orderItems)
            .set({ qty, ...(delta > 0 ? { doneAt: null } : {}) })
            .where(eq(orderItems.id, itemId))
            .run()

          const all = tx.select().from(orderItems).where(eq(orderItems.orderId, id)).all()
          const active = all.filter((i) => i.cancelledAt === null)
          const totalCents =
            active.reduce((sum, i) => sum + i.priceCentsSnapshot * i.qty, 0) +
            order.covers * order.coverChargeCents
          const completedAt =
            active.length > 0 && active.every((i) => i.doneAt !== null)
              ? (order.completedAt ?? now)
              : null
          const updated = tx
            .update(orders)
            .set({ totalCents, completedAt })
            .where(eq(orders.id, id))
            .returning()
            .get()!
          return { updated, items: all }
        })
      } catch (err) {
        if (err instanceof Error && err.message === 'OUT_OF_STOCK') {
          return reply.code(409).send({ error: 'out_of_stock' })
        }
        if (err instanceof Error && err.message === 'PRODUCT_UNAVAILABLE') {
          return reply.code(409).send({ error: 'products_unavailable' })
        }
        throw err
      }

      req.log.info(
        {
          event: 'order_item_qty_changed',
          by: req.user!.id,
          orderId: id,
          itemId,
          from: item.qty,
          to: qty,
        },
        'audit',
      )
      notifyOrdersChanged()
      return { ...result.updated, items: result.items }
    })

    /** Re-send the kitchen ticket to CUPS — the jam-recovery button. */
    app.post('/api/orders/:id/print', async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const order = await loadVisibleOrder(id, req.user!)
      if (order === 'not_found') return reply.code(404).send({ error: 'not_found' })
      if (order === 'forbidden') return reply.code(403).send({ error: 'forbidden' })

      if (!kitchenQueue()) {
        return reply.code(409).send({ error: 'printer_not_configured' })
      }
      const result = await printKitchenTicket(db, order)
      if (!result.ok) {
        return reply.code(502).send({ error: result.error, detail: result.detail })
      }
      return { ok: true, printedAt: result.printedAt }
    })

    /** Admins and maîtres see the whole service; operators only what they rang up. */
    app.get('/api/orders', async (req) => {
      const q = req.query as { day?: string; mine?: string }
      const day = q.day && isServiceDay(q.day) ? q.day : serviceDayOf()

      const restrictToSelf = !isManager(req.user!) || q.mine === 'true'
      const where = restrictToSelf
        ? and(eq(orders.serviceDay, day), eq(orders.createdBy, req.user!.id))
        : eq(orders.serviceDay, day)

      // Second join on users under an alias: who cancelled ≠ who created.
      const cancellers = alias(users, 'cancellers')
      const rows = await db
        .select({
          id: orders.id,
          dailyNumber: orders.dailyNumber,
          serviceDay: orders.serviceDay,
          customerName: orders.customerName,
          covers: orders.covers,
          cancelledAt: orders.cancelledAt,
          cancelledByName: cancellers.displayName,
          completedAt: orders.completedAt,
          note: orders.note,
          totalCents: orders.totalCents,
          createdAt: orders.createdAt,
          printedAt: orders.printedAt,
          printError: orders.printError,
          createdByName: users.displayName,
        })
        .from(orders)
        .innerJoin(users, eq(users.id, orders.createdBy))
        .leftJoin(cancellers, eq(cancellers.id, orders.cancelledBy))
        .where(where)
        .orderBy(desc(orders.dailyNumber))

      return { serviceDay: day, orders: rows }
    })

    app.get('/api/orders/:id', async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const order = (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0]
      if (!order) return reply.code(404).send({ error: 'not_found' })

      // An operator must not be able to read a colleague's order by guessing ids.
      if (!isManager(req.user!) && order.createdBy !== req.user!.id) {
        return reply.code(403).send({ error: 'forbidden' })
      }

      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, id))
      const cancelledByName = order.cancelledBy
        ? ((
            await db
              .select({ name: users.displayName })
              .from(users)
              .where(eq(users.id, order.cancelledBy))
              .limit(1)
          )[0]?.name ?? null)
        : null
      return { ...order, cancelledByName, items }
    })
  }
}
