import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
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
 * the money. Verification runs from three directions — the customer's own
 * status polling, the background sweeper, and a manager's cancel — and every
 * path that can move money or expire the order takes the same per-order lock
 * and re-reads the order's committed state first, so no pass ever captures a
 * payment for an order another pass has already cancelled and restocked.
 */

/** How long an unpaid held order may live before it is expired. */
const HELD_TTL_S = 15 * 60

/**
 * How long a held order waits when its payment provider has vanished from the
 * configuration. Long enough that the provider's own checkout has expired on
 * their side, so releasing the stock cannot strand a late payment.
 */
const PROVIDER_GONE_GRACE_S = 24 * 60 * 60

/** A row is held when its online payment is still in flight. */
export function isHeld(
  order: Pick<Order, 'origin' | 'paymentRef' | 'paidAt' | 'cancelledAt'>,
): boolean {
  return (
    order.origin === 'customer' &&
    order.paymentRef !== null &&
    order.paidAt === null &&
    order.cancelledAt === null
  )
}

/** isHeld() as a query filter — the same rule, expressed for the database. */
export const heldOrderFilter = and(
  eq(orders.origin, 'customer'),
  isNotNull(orders.paymentRef),
  isNull(orders.paidAt),
  isNull(orders.cancelledAt),
)

/**
 * The negation, for "everything except money still in flight": an order with
 * no provider reference, one already paid, or one already cancelled.
 */
export const notHeldFilter = or(
  isNull(orders.paymentRef),
  isNotNull(orders.paidAt),
  isNotNull(orders.cancelledAt),
)

/**
 * A per-order-id async lock. The venue box is a single Node process, so an
 * in-process mutex fully serializes the sweeper, the customer poll and the
 * manager cancel against one another for a given order. Check-and-set below
 * has no await between the `has` test and the `set`, so it is atomic on the
 * event loop.
 */
const orderLocks = new Map<number, Promise<void>>()
async function withOrderLock<T>(id: number, fn: () => Promise<T>): Promise<T> {
  while (orderLocks.has(id)) await orderLocks.get(id)!.catch(() => {})
  let release!: () => void
  orderLocks.set(
    id,
    new Promise<void>((r) => (release = r)),
  )
  try {
    return await fn()
  } finally {
    orderLocks.delete(id)
    release()
  }
}

async function loadOrder(db: Db, id: number): Promise<Order | undefined> {
  return (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0]
}

/** Money confirmed: release the order to the kitchen. Idempotent — the
 * conditional update makes exactly one caller the winner. Returns false when
 * the order was no longer finalizable (already paid, or cancelled meanwhile). */
async function finalizeHeldOrder(
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
 * order and give its reserved stock back. `cancelledBy` records a manager
 * when the cancel was human; the sweeper/TTL path leaves it null (system). */
export async function expireHeldOrder(
  db: Db,
  order: Order,
  log?: FastifyBaseLogger,
  cancelledBy: number | null = null,
) {
  const now = Math.floor(Date.now() / 1000)
  db.transaction((tx) => {
    const row = tx
      .update(orders)
      .set({ cancelledAt: now, cancelledBy })
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
    { event: 'held_order_expired', orderId: order.id, dailyNumber: order.dailyNumber, cancelledBy },
    'audit',
  )
  notifyOrdersChanged()
}

/**
 * Money landed on an order we can no longer deliver (it was cancelled while
 * the capture was in flight). Keeping the customer's money is never
 * acceptable — refund it. Best-effort: a failed refund is logged loudly for
 * a human, exactly like the manager-cancel refund path.
 */
async function refundOrphanedCapture(
  db: Db,
  providers: ProviderRegistry,
  order: Order,
  log?: FastifyBaseLogger,
) {
  const provider = providers.get(order.paymentMethod as OnlineMethod)
  if (!provider || !order.paymentRef) return
  try {
    await provider.refund(order.paymentRef)
    await db
      .update(orders)
      .set({ refundedAt: Math.floor(Date.now() / 1000) })
      .where(eq(orders.id, order.id))
    log?.warn(
      { event: 'orphaned_capture_refunded', orderId: order.id, totalCents: order.totalCents },
      'audit',
    )
  } catch (err) {
    log?.error(
      { err, event: 'orphaned_capture_refund_failed', orderId: order.id },
      'captured money on a cancelled order could not be refunded — handle manually',
    )
  }
}

/**
 * One verification pass over a held order. Called from the customer status
 * route and from the sweeper. Serialized per order and re-reads committed
 * state before doing anything, so it never captures for an order that was
 * cancelled meanwhile; if a capture nonetheless lands on a cancelled order,
 * the money is refunded rather than kept.
 */
export async function verifyHeldOrder(
  db: Db,
  providers: ProviderRegistry,
  order: Order,
  log?: FastifyBaseLogger,
): Promise<'paid' | 'pending' | 'expired'> {
  return withOrderLock(order.id, async () => {
    const fresh = await loadOrder(db, order.id)
    if (!fresh) return 'expired'
    if (fresh.paidAt) return 'paid' // finalized by another pass
    if (fresh.cancelledAt) return 'expired' // expired/cancelled by another pass
    if (!isHeld(fresh)) return 'pending'

    const age = Math.floor(Date.now() / 1000) - fresh.createdAt

    const provider = providers.get(fresh.paymentMethod as OnlineMethod)
    if (!provider) {
      // The provider was removed from the configuration while this order was
      // mid-checkout. We can neither verify nor cancel it, so we hold — but
      // not forever, or its stock and its slot under the order cap are lost
      // for the rest of the service. After a long grace the provider's own
      // checkout has expired on their side too (Stripe sessions last at most
      // 24h), so releasing the stock can no longer strand a late payment.
      if (age > PROVIDER_GONE_GRACE_S) {
        log?.warn(
          { event: 'held_order_released_provider_gone', orderId: fresh.id, method: fresh.paymentMethod },
          'payment provider is no longer configured — releasing the reserved stock',
        )
        await expireHeldOrder(db, fresh, log)
        return 'expired'
      }
      return 'pending'
    }

    const check = await provider.verifyPayment(fresh.paymentRef!)
    if (check === 'paid') {
      const delivered = await finalizeHeldOrder(db, fresh, log)
      if (!delivered) {
        // The order was cancelled between our re-read and the capture: money
        // moved but there is no order to deliver. Refund it.
        const after = await loadOrder(db, fresh.id)
        if (after?.cancelledAt && !after.paidAt) {
          await refundOrphanedCapture(db, providers, after, log)
        }
      }
      return 'paid'
    }
    if (check === 'failed') {
      await expireHeldOrder(db, fresh, log)
      return 'expired'
    }

    if (age > HELD_TTL_S) {
      // Make sure the payment can never complete late, THEN cancel. If the
      // provider refuses (e.g. it just completed), stay held: the next verify
      // will see paid and deliver the order instead of losing the money.
      await provider.cancelPayment(fresh.paymentRef!)
      await expireHeldOrder(db, fresh, log)
      return 'expired'
    }
    return 'pending'
  })
}

/**
 * A manager cancels a held (mid-checkout, unpaid) online order. This must
 * kill the provider's checkout so the customer cannot pay after the cancel,
 * and restock — the plain cancel route does neither. Shares the per-order
 * lock with verification so the two can never interleave.
 */
export type HeldCancelOutcome = 'cancelled' | 'already_cancelled' | 'paid' | 'in_progress'

export async function cancelHeldOrder(
  db: Db,
  providers: ProviderRegistry,
  order: Order,
  log: FastifyBaseLogger,
  cancelledBy: number,
): Promise<HeldCancelOutcome> {
  return withOrderLock(order.id, async () => {
    const fresh = await loadOrder(db, order.id)
    if (!fresh) return 'already_cancelled'
    if (fresh.cancelledAt) return 'already_cancelled'
    // Finalized while we waited for the lock: the caller must refund it via
    // the normal paid-cancel path (retry), not expire it.
    if (fresh.paidAt) return 'paid'
    if (!isHeld(fresh)) return 'paid'

    const provider = providers.get(fresh.paymentMethod as OnlineMethod)
    if (!provider) {
      // Provider vanished from config while this order was mid-checkout: we
      // cannot prove the checkout is dead, so we must not cancel and restock.
      // Leave it held (a graceful 409) rather than crash the route.
      log.warn({ orderId: fresh.id, method: fresh.paymentMethod }, 'held cancel: provider gone')
      return 'in_progress'
    }
    try {
      // Guarantees no late capture. Throws only if the payment already
      // completed — in which case we must not cancel: leave it held so the
      // next verify delivers it (and a retry of the cancel then refunds).
      await provider.cancelPayment(fresh.paymentRef!)
    } catch (err) {
      log.warn({ err, orderId: fresh.id }, 'held order cancel: payment already completing')
      return 'in_progress'
    }
    await expireHeldOrder(db, fresh, log, cancelledBy)
    log.info(
      { event: 'held_order_cancelled_by_manager', orderId: fresh.id, by: cancelledBy },
      'audit',
    )
    return 'cancelled'
  })
}

/**
 * Minutes an unpaid customer *counter* order may hold its reserved stock
 * before it is auto-expired. Longer than the online hold (the customer is
 * physically walking to the till, not sitting on a checkout page).
 * Configurable per venue; default 30 minutes.
 */
function counterTtlS(): number {
  const n = Number(process.env.COUNTER_ORDER_TTL_MIN)
  return (Number.isFinite(n) && n > 0 ? n : 30) * 60
}

/**
 * Unpaid customer counter orders reserve stock at creation but have no
 * provider to expire them — without this an abandoned (or malicious) counter
 * order would hold its portions off the menu indefinitely. Expire and restock
 * the stale ones. Runs regardless of whether any payment provider exists.
 * The conditional update inside expireHeldOrder is the arbiter against a
 * cashier marking the same order paid at that moment: exactly one wins.
 */
let counterSweepRunning = false

export async function sweepStaleCounterOrders(db: Db, log?: FastifyBaseLogger) {
  if (counterSweepRunning) return
  counterSweepRunning = true
  try {
    await runCounterSweep(db, log)
  } finally {
    counterSweepRunning = false
  }
}

async function runCounterSweep(db: Db, log?: FastifyBaseLogger) {
  const cutoff = Math.floor(Date.now() / 1000) - counterTtlS()
  const stale = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.origin, 'customer'),
        isNull(orders.paymentRef), // counter, not an online-payment hold
        isNull(orders.paidAt),
        isNull(orders.cancelledAt),
        lt(orders.createdAt, cutoff),
      ),
    )
  for (const order of stale) {
    try {
      await expireHeldOrder(db, order, log)
    } catch (err) {
      log?.warn({ err, orderId: order.id }, 'counter order expiry failed; will retry')
    }
  }
}

// One sweep at a time. A slow or hanging provider makes a pass outlast the
// 30-second interval; without this the passes stack up, each re-verifying the
// same orders and multiplying the outbound calls.
let heldSweepRunning = false

/** Background sweep for customers who closed their browser mid-payment. */
export async function sweepHeldOrders(db: Db, providers: ProviderRegistry, log?: FastifyBaseLogger) {
  // No early return on an empty registry: a venue that removed its only
  // provider key is EXACTLY the case where held orders need releasing, and
  // skipping the sweep there would strand their stock for the whole service.
  // With nothing held the query below costs one indexed lookup.
  if (heldSweepRunning) {
    log?.debug('held-order sweep still running; skipping this tick')
    return
  }
  heldSweepRunning = true
  try {
    await runHeldSweep(db, providers, log)
  } finally {
    heldSweepRunning = false
  }
}

async function runHeldSweep(db: Db, providers: ProviderRegistry, log?: FastifyBaseLogger) {
  const held = await db.select().from(orders).where(heldOrderFilter)
  for (const order of held) {
    try {
      await verifyHeldOrder(db, providers, order, log)
    } catch (err) {
      log?.warn({ err, orderId: order.id }, 'held order verification failed; will retry')
    }
  }
}
