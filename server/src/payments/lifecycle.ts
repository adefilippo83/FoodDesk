import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../db/index.js'
import { orderItems, orders, products, type Order } from '../db/schema.js'
import { notifyOrdersChanged } from '../lib/events.js'
import { printKitchenTicket } from '../print/service.js'
import type { OnlineMethod, ProviderRegistry } from './provider.js'

/**
 * The held-order lifecycle: an online-paying customer order exists in the
 * database (its stock is reserved, its number allocated) but stays out of
 * the kitchen, the staff lists and the reports until the provider confirms
 * the money. Verification runs from two directions — the customer's own
 * status polling and the background sweeper — and both funnel through the
 * same conditional-update finalization, so double delivery is impossible.
 */

/** How long an unpaid held order may live before it is expired. */
export const HELD_TTL_S = 15 * 60

export function isHeld(order: Order): boolean {
  return (
    order.origin === 'customer' &&
    order.paymentRef !== null &&
    order.paidAt === null &&
    order.cancelledAt === null
  )
}

/** Money confirmed: release the order to the kitchen. Idempotent — the
 * conditional update makes exactly one caller the winner. */
export async function finalizeHeldOrder(
  db: Db,
  order: Order,
  log?: FastifyBaseLogger,
): Promise<boolean> {
  const updated = (
    await db
      .update(orders)
      .set({ paidAt: Math.floor(Date.now() / 1000) })
      .where(and(eq(orders.id, order.id), isNull(orders.paidAt), isNull(orders.cancelledAt)))
      .returning()
  )[0]
  if (!updated) return false

  log?.info(
    {
      event: 'online_payment_confirmed',
      orderId: order.id,
      dailyNumber: order.dailyNumber,
      method: order.paymentMethod,
      totalCents: order.totalCents,
    },
    'audit',
  )
  printKitchenTicket(db, updated).catch((err) => log?.error(err, 'kitchen print crashed'))
  notifyOrdersChanged()
  return true
}

/** The payment is dead (expired or provider-declared failed): cancel the
 * order and give its reserved stock back. */
export async function expireHeldOrder(db: Db, order: Order, log?: FastifyBaseLogger) {
  const now = Math.floor(Date.now() / 1000)
  db.transaction((tx) => {
    const row = tx
      .update(orders)
      .set({ cancelledAt: now })
      .where(and(eq(orders.id, order.id), isNull(orders.paidAt), isNull(orders.cancelledAt)))
      .returning()
      .get()
    if (!row) return
    const items = tx.select().from(orderItems).where(eq(orderItems.orderId, order.id)).all()
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
  })
  log?.info(
    { event: 'held_order_expired', orderId: order.id, dailyNumber: order.dailyNumber },
    'audit',
  )
}

/**
 * One verification pass over a held order. Called from the customer status
 * route and from the sweeper; both are safe concurrently.
 */
export async function verifyHeldOrder(
  db: Db,
  providers: ProviderRegistry,
  order: Order,
  log?: FastifyBaseLogger,
): Promise<'paid' | 'pending' | 'expired'> {
  const provider = providers.get(order.paymentMethod as OnlineMethod)
  if (!provider) return 'pending' // provider vanished from config: leave held

  const check = await provider.verifyPayment(order.paymentRef!)
  if (check === 'paid') {
    await finalizeHeldOrder(db, order, log)
    return 'paid'
  }
  if (check === 'failed') {
    await expireHeldOrder(db, order, log)
    return 'expired'
  }

  const age = Math.floor(Date.now() / 1000) - order.createdAt
  if (age > HELD_TTL_S) {
    // Make sure the payment can never complete late, THEN cancel. If the
    // provider refuses (e.g. it just completed), stay held: the next verify
    // will see paid and deliver the order instead of losing the money.
    await provider.cancelPayment(order.paymentRef!)
    await expireHeldOrder(db, order, log)
    return 'expired'
  }
  return 'pending'
}

/** Background sweep for customers who closed their browser mid-payment. */
export async function sweepHeldOrders(db: Db, providers: ProviderRegistry, log?: FastifyBaseLogger) {
  if (providers.size === 0) return
  const held = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.origin, 'customer'),
        isNotNull(orders.paymentRef),
        isNull(orders.paidAt),
        isNull(orders.cancelledAt),
      ),
    )
  for (const order of held) {
    try {
      await verifyHeldOrder(db, providers, order, log)
    } catch (err) {
      log?.warn({ err, orderId: order.id }, 'held order verification failed; will retry')
    }
  }
}
