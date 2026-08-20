import { and, desc, eq, gte, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { FastifyInstance } from 'fastify'
import { isManager, requireFloorStaff, requireManager } from '../auth/acl.js'
import type { Db } from '../db/index.js'
import { orderItems, orders, products, users, type Order } from '../db/schema.js'
import { notifyOrdersChanged } from '../lib/events.js'
import { isServiceDay, serviceDayOf } from '../lib/serviceDay.js'
import { parseItems, placeOrder } from '../lib/placeOrder.js'
import { cancelHeldOrder, isHeld } from '../payments/lifecycle.js'
import type { OnlineMethod, ProviderRegistry } from '../payments/provider.js'
import { renderKitchenTicket, renderOrderSheet, renderReceipt } from '../print/pdf.js'
import { kitchenQueue, printKitchenTicket } from '../print/service.js'
import { loadSettings } from '../settings.js'

export function orderRoutes(db: Db, providers: ProviderRegistry) {
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

      // Snapshot the coperto amount now: changing it in settings tomorrow
      // must not change tonight's bills.
      const { coverChargeCents } = await loadSettings(db)

      const result = await placeOrder(db, {
        items: parsed,
        customerName,
        covers,
        coverChargeCents,
        note,
        clientKey,
        createdBy: req.user!.id,
        origin: 'staff',
        publicToken: null,
      })
      if (!result.ok) {
        if (result.code === 'unknown_products') {
          return reply.code(400).send({ error: 'unknown_products', missing: result.ids })
        }
        if (result.code === 'products_unavailable') {
          return reply.code(409).send({ error: 'products_unavailable', unavailable: result.ids })
        }
        if (result.code === 'payload_mismatch') {
          return reply.code(409).send({ error: 'payload_mismatch' })
        }
        return reply.code(409).send({ error: 'out_of_stock', unavailable: result.ids })
      }
      if (result.replayed) {
        return reply.code(200).send({ ...result.order, items: result.items })
      }

      // Print in the background: the waiter gets their confirmation now, and a
      // slow or jammed printer shows up as printError on the order instead.
      printKitchenTicket(db, result.order).catch((err) => req.log.error(err, 'kitchen print crashed'))

      notifyOrdersChanged()
      return reply.code(201).send({ ...result.order, items: result.items })
    })

    /** Loads an order enforcing the same visibility rule everywhere. */
    async function loadVisibleOrder(
      id: number,
      user: { id: number; role: string },
    ): Promise<Order | 'not_found' | 'forbidden'> {
      const order = (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0]
      if (!order) return 'not_found'
      // A held online-payment order is not staff business (yet): invisible.
      if (isHeld(order)) return 'not_found'
      // Customer orders have no author — the whole floor handles them.
      if (!isManager(user) && order.createdBy !== null && order.createdBy !== user.id) {
        return 'forbidden'
      }
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

      // A held (mid-checkout, unpaid) online order is a different animal: the
      // plain cancel below neither kills the live provider checkout — so the
      // customer could still pay after the cancel with no refund — nor gives
      // the reserved stock back. Route it through the lifecycle instead.
      if (isHeld(order)) {
        const outcome = await cancelHeldOrder(db, providers, order, req.log, req.user!.id)
        if (outcome === 'in_progress' || outcome === 'paid') {
          // Payment is completing (or just completed): do not cancel now. A
          // retry once it settles takes the normal paid-cancel+refund path.
          return reply.code(409).send({ error: 'payment_in_progress' })
        }
        const row = (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0]!
        return { ...row }
      }

      const now = Math.floor(Date.now() / 1000)
      const updated = db.transaction((tx) => {
        // Conditional on "not already cancelled": two managers hitting cancel
        // at once would otherwise both pass the read check above, both restock,
        // and both fire a refund — charging the venue twice.
        const row = tx
          .update(orders)
          .set({ cancelledAt: now, cancelledBy: req.user!.id })
          .where(and(eq(orders.id, id), isNull(orders.cancelledAt)))
          .returning()
          .get()
        if (!row) return null
        // The whole order is off — its active lines return their reserved
        // stock, exactly like cancelling each line individually does. A
        // product that sold out through this order comes back on the menu.
        const items = tx.select().from(orderItems).where(eq(orderItems.orderId, id)).all()
        for (const item of items.filter((i) => i.cancelledAt === null)) {
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
        return row
      })
      if (!updated) {
        // A concurrent cancel won: it is doing (or has done) the restock and
        // the refund. Answer idempotently with the current row.
        const current = (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0]!
        return { ...current }
      }
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

      // Online-paid order cancelled by a manager: the customer gets their
      // money back, automatically and in full.
      let refundFailed = false
      if (updated.paidAt && updated.paymentRef && updated.paymentMethod !== 'cash') {
        const provider = providers.get(updated.paymentMethod as OnlineMethod)
        try {
          if (!provider) throw new Error(`no provider for ${updated.paymentMethod}`)
          await provider.refund(updated.paymentRef)
          await db
            .update(orders)
            .set({ refundedAt: Math.floor(Date.now() / 1000) })
            .where(eq(orders.id, id))
          req.log.info(
            { event: 'order_refunded', orderId: id, totalCents: updated.totalCents },
            'audit',
          )
        } catch (err) {
          refundFailed = true
          req.log.error({ err, orderId: id }, 'automatic refund FAILED — handle manually')
        }
      }
      notifyOrdersChanged()
      return { ...updated, ...(refundFailed ? { refundFailed: true } : {}) }
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
      // No partial refunds in phase B: an online-paid order's lines and
      // amounts are frozen; only a full cancel (with full refund) changes it.
      if (order.paidAt && order.paymentMethod !== null && order.paymentMethod !== 'cash') {
        return reply.code(409).send({ error: 'online_paid_locked' })
      }

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

        const orderCancelled = active.length === 0
        // Nothing left to serve means nothing owed — not even the coperto.
        // Otherwise the cancelled order would keep a phantom cover-charge
        // total that shows up on screen and in the CSV.
        const totalCents = orderCancelled
          ? 0
          : active.reduce((sum, i) => sum + i.priceCentsSnapshot * i.qty, 0) +
            order.covers * order.coverChargeCents
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
      // No partial refunds in phase B: an online-paid order's lines and
      // amounts are frozen; only a full cancel (with full refund) changes it.
      if (order.paidAt && order.paymentMethod !== null && order.paymentMethod !== 'cash') {
        return reply.code(409).send({ error: 'online_paid_locked' })
      }

      const item = (
        await db.select().from(orderItems).where(eq(orderItems.id, itemId)).limit(1)
      )[0]
      if (!item || item.orderId !== id) return reply.code(404).send({ error: 'not_found' })
      if (item.cancelledAt) return reply.code(409).send({ error: 'item_cancelled' })
      if (qty === item.qty) return reply.code(400).send({ error: 'nothing_to_update' })

      const now = Math.floor(Date.now() / 1000)
      let result
      try {
        result = db.transaction((tx) => {
          // The delta has to come from the row as it is NOW, inside the
          // transaction: two waiters editing the same line concurrently would
          // otherwise both compute their delta against the same stale qty and
          // move the stock twice for one change.
          const fresh = tx.select().from(orderItems).where(eq(orderItems.id, itemId)).get()
          if (!fresh || fresh.cancelledAt) throw new Error('ITEM_GONE')
          const delta = qty - fresh.qty
          if (delta === 0) throw new Error('NOTHING_TO_UPDATE')

          if (delta > 0) {
            const product = tx
              .select()
              .from(products)
              .where(eq(products.id, fresh.productId))
              .get()
            if (!product || !product.active) throw new Error('PRODUCT_UNAVAILABLE')
            if (product.stockRemaining !== null) {
              const res = tx
                .update(products)
                .set({ stockRemaining: sql`${products.stockRemaining} - ${delta}` })
                .where(
                  and(
                    eq(products.id, fresh.productId),
                    isNotNull(products.stockRemaining),
                    gte(products.stockRemaining, delta),
                  ),
                )
                .run()
              if (res.changes === 0) throw new Error('OUT_OF_STOCK')
              tx.update(products)
                .set({ active: false })
                .where(and(eq(products.id, fresh.productId), lte(products.stockRemaining, 0)))
                .run()
            }
          } else {
            const back = -delta
            tx.update(products)
              .set({ stockRemaining: sql`${products.stockRemaining} + ${back}` })
              .where(and(eq(products.id, fresh.productId), isNotNull(products.stockRemaining)))
              .run()
            tx.update(products)
              .set({ active: true })
              .where(
                and(
                  eq(products.id, fresh.productId),
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
        // The line changed under us between the read and the transaction.
        if (err instanceof Error && err.message === 'ITEM_GONE') {
          return reply.code(409).send({ error: 'item_cancelled' })
        }
        if (err instanceof Error && err.message === 'NOTHING_TO_UPDATE') {
          return reply.code(400).send({ error: 'nothing_to_update' })
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

    /** Cash at pickup: mark an order as paid (customer self-orders, mostly). */
    app.post('/api/orders/:id/paid', async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const order = await loadVisibleOrder(id, req.user!)
      if (order === 'not_found') return reply.code(404).send({ error: 'not_found' })
      if (order === 'forbidden') return reply.code(403).send({ error: 'forbidden' })
      if (order.cancelledAt) return reply.code(409).send({ error: 'order_cancelled' })
      if (order.paidAt) return { ...order } // idempotent
      // An order routed through an online provider is paid online or not at
      // all — the counter must not be able to bypass the payment flow.
      if (order.paymentMethod !== null) {
        return reply.code(409).send({ error: 'online_payment_pending' })
      }

      // Conditional: the counter-order TTL sweep may cancel this very order
      // between our read and this write. The WHERE makes exactly one of the
      // two win — an order can never end up both cancelled and paid.
      const updated = (
        await db
          .update(orders)
          .set({ paidAt: Math.floor(Date.now() / 1000), paymentMethod: 'cash' })
          .where(and(eq(orders.id, id), isNull(orders.paidAt), isNull(orders.cancelledAt)))
          .returning()
      )[0]
      if (!updated) {
        // Lost the race: report what actually happened.
        const now = (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0]!
        if (now.cancelledAt) return reply.code(409).send({ error: 'order_cancelled' })
        return { ...now } // paid by a colleague meanwhile — idempotent
      }
      req.log.info(
        { event: 'order_paid', by: req.user!.id, orderId: id, method: 'cash' },
        'audit',
      )
      // Paying at the counter is what releases a customer order to the
      // kitchen — the ticket prints now, not at creation.
      if (updated.origin === 'customer') {
        printKitchenTicket(db, updated).catch((err) => req.log.error(err, 'kitchen print crashed'))
      }
      notifyOrdersChanged()
      return updated
    })

    /** Admins and maîtres see the whole service; operators only what they rang up. */
    app.get('/api/orders', async (req) => {
      const q = req.query as { day?: string; mine?: string }
      const day = q.day && isServiceDay(q.day) ? q.day : serviceDayOf()

      const restrictToSelf = !isManager(req.user!) || q.mine === 'true'
      // Operators see what they rang up plus customer self-orders (which
      // have no author and are everyone's business at the counter). Held
      // online-payment orders appear too, flagged: staff see the payment
      // in progress but the money is not counted until it is confirmed.
      const where = restrictToSelf
        ? and(
            eq(orders.serviceDay, day),
            or(eq(orders.createdBy, req.user!.id), isNull(orders.createdBy)),
          )
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
          origin: orders.origin,
          paidAt: orders.paidAt,
          paymentMethod: orders.paymentMethod,
          paymentRef: orders.paymentRef,
          refundedAt: orders.refundedAt,
          createdByName: users.displayName,
        })
        .from(orders)
        .leftJoin(users, eq(users.id, orders.createdBy))
        .leftJoin(cancellers, eq(cancellers.id, orders.cancelledBy))
        .where(where)
        .orderBy(desc(orders.dailyNumber))

      // The provider reference stays server-side; the client only needs to
      // know the order is still waiting for its money.
      return {
        serviceDay: day,
        orders: rows.map(({ paymentRef, ...r }) => ({
          ...r,
          held: isHeld({ ...r, paymentRef }),
        })),
      }
    })

    app.get('/api/orders/:id', async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const order = (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0]
      if (!order) return reply.code(404).send({ error: 'not_found' })

      // An operator must not be able to read a colleague's order by guessing
      // ids — customer orders (no author) are fair game for the whole floor.
      if (!isManager(req.user!) && order.createdBy !== null && order.createdBy !== req.user!.id) {
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
      // Never hand the client the provider payment reference, the idempotency
      // key or the unguessable public token — none are staff business and the
      // token would let anyone follow the customer's order.
      const safe: Partial<typeof order> = { ...order }
      delete safe.paymentRef
      delete safe.clientKey
      delete safe.publicToken
      return { ...safe, held: isHeld(order), cancelledByName, items }
    })
  }
}
