import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { requireRole } from '../auth/acl.js'
import type { Db } from '../db/index.js'
import { orderItems, orders, users } from '../db/schema.js'
import { notifyOrdersChanged } from '../lib/events.js'
import { serviceDayOf } from '../lib/serviceDay.js'

/**
 * The kitchen display exists only while at least one active kitchen account
 * does: creating the first one turns the feature on, disabling the last one
 * turns it off again.
 */
export async function kitchenFeatureEnabled(db: Db): Promise<boolean> {
  const row = (
    await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'kitchen'), eq(users.active, true)))
      .limit(1)
  )[0]
  return Boolean(row)
}

export function kitchenRoutes(db: Db) {
  return async function register(app: FastifyInstance) {
    // The kitchen display: dedicated kitchen accounts, plus admin and maître.
    // A kitchen account can reach ONLY these routes (and its own auth).
    app.addHook('preHandler', requireRole('admin', 'maitre', 'kitchen'))
    app.addHook('preHandler', async (req, reply) => {
      // A kitchen caller proves the feature is on by existing (sessions of
      // disabled accounts die immediately); managers need the check.
      if (req.user!.role === 'kitchen') return
      if (!(await kitchenFeatureEnabled(db))) {
        return reply.code(404).send({ error: 'kitchen_disabled' })
      }
    })

    // A cancelled order must not just vanish from the display — a cook who
    // is mid-dish needs to SEE the cancellation. Keep it on screen, marked,
    // for a grace window before it drops off.
    const CANCELLED_VISIBLE_S = 10 * 60

    /** Today's active orders (plus freshly cancelled ones) with item state. */
    app.get('/api/kitchen/orders', async () => {
      const day = serviceDayOf()
      const now = Math.floor(Date.now() / 1000)
      const orderRows = await db
        .select({
          id: orders.id,
          dailyNumber: orders.dailyNumber,
          customerName: orders.customerName,
          covers: orders.covers,
          note: orders.note,
          createdAt: orders.createdAt,
          cancelledAt: orders.cancelledAt,
          completedAt: orders.completedAt,
          createdByName: users.displayName,
        })
        .from(orders)
        .leftJoin(users, eq(users.id, orders.createdBy))
        .where(
          and(
            eq(orders.serviceDay, day),
            or(isNull(orders.cancelledAt), gt(orders.cancelledAt, now - CANCELLED_VISIBLE_S)),
            // Online-payment orders reach the kitchen only once paid — and an
            // expired one (cancelled, never paid) must not flash ANNULLATO
            // for a ticket the kitchen never saw.
            or(isNull(orders.paymentRef), isNotNull(orders.paidAt)),
          ),
        )
        .orderBy(asc(orders.dailyNumber))

      const ids = orderRows.map((o) => o.id)
      const itemRows = ids.length
        ? await db.select().from(orderItems).where(inArray(orderItems.orderId, ids))
        : []

      return {
        serviceDay: day,
        orders: orderRows.map((o) => ({
          ...o,
          items: itemRows
            .filter((i) => i.orderId === o.id)
            .map((i) => ({
              id: i.id,
              qty: i.qty,
              name: i.nameSnapshot,
              category: i.categoryNameSnapshot,
              note: i.note,
              doneAt: i.doneAt,
              cancelledAt: i.cancelledAt,
            })),
        })),
      }
    })

    /** Tap: mark one line prepared, or back to pending (mis-taps happen). */
    app.put('/api/kitchen/items/:id', async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const done = (req.body as { done?: unknown } | undefined)?.done
      if (typeof done !== 'boolean') {
        return reply.code(400).send({ error: 'done_boolean_required' })
      }
      const item = (await db.select().from(orderItems).where(eq(orderItems.id, id)).limit(1))[0]
      if (!item) return reply.code(404).send({ error: 'not_found' })
      // A cancelled line is out of the game — nothing left to prepare.
      if (item.cancelledAt) return reply.code(409).send({ error: 'item_cancelled' })

      const now = Math.floor(Date.now() / 1000)
      // Item state and the order's completion flag move together: the order is
      // completed exactly when its last pending active item is marked done,
      // and drops back to open the moment any item is reopened.
      const result = db.transaction((tx) => {
        const updated = tx
          .update(orderItems)
          .set({ doneAt: done ? now : null })
          .where(eq(orderItems.id, id))
          .returning()
          .get()!
        const pending = tx
          .select({ id: orderItems.id })
          .from(orderItems)
          .where(
            and(
              eq(orderItems.orderId, item.orderId),
              isNull(orderItems.doneAt),
              isNull(orderItems.cancelledAt),
            ),
          )
          .all()
        const orderCompleted = pending.length === 0
        tx.update(orders)
          .set({ completedAt: orderCompleted ? now : null })
          .where(eq(orders.id, item.orderId))
          .run()
        return { ...updated, orderCompleted }
      })

      req.log.info(
        {
          event: done ? 'kitchen_item_done' : 'kitchen_item_reopened',
          by: req.user!.id,
          itemId: id,
          orderId: item.orderId,
          orderCompleted: result.orderCompleted,
        },
        'audit',
      )
      notifyOrdersChanged()
      return result
    })
  }
}
