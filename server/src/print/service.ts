import { and, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../db/index.js'
import { orderItems, orders, type Order } from '../db/schema.js'
import { notifyOrdersChanged } from '../lib/events.js'
import { loadSettings } from '../settings.js'
import { renderKitchenTicket } from './pdf.js'
import { sendToCups } from './printer.js'

export type PrintResult =
  | { ok: true; printedAt: number }
  | { ok: false; error: 'printer_not_configured' | 'print_failed'; detail?: string }

export function kitchenQueue(): string | undefined {
  return process.env.KITCHEN_PRINTER || undefined
}

/**
 * Renders and prints the kitchen ticket for an order, recording the outcome
 * on the order row either way. An order whose print failed stays visible in
 * the UI with its error until a reprint succeeds — a jammed printer must
 * never silently swallow a ticket.
 */
// Auto-retry: a briefly offline printer must not require anyone to notice
// and press Reprint. Recent failed tickets are retried in the background
// until they print or exhaust the attempt cap (manual reprint always works).
const RETRY_MAX_ATTEMPTS = 5
const RETRY_WINDOW_S = 30 * 60

/** One background sweep: re-print recent failed, uncancelled tickets. */
export async function retryFailedPrints(db: Db, log?: FastifyBaseLogger): Promise<void> {
  if (!kitchenQueue()) return
  const cutoff = Math.floor(Date.now() / 1000) - RETRY_WINDOW_S
  const failed = await db
    .select()
    .from(orders)
    .where(
      and(
        isNull(orders.printedAt),
        isNotNull(orders.printError),
        isNull(orders.cancelledAt),
        lt(orders.printAttempts, RETRY_MAX_ATTEMPTS),
        gt(orders.createdAt, cutoff),
      ),
    )
  for (const order of failed) {
    const result = await printKitchenTicket(db, order)
    log?.info(
      {
        event: result.ok ? 'print_retry_ok' : 'print_retry_failed',
        orderId: order.id,
        dailyNumber: order.dailyNumber,
        attempt: order.printAttempts + 1,
      },
      'audit',
    )
  }
}

export async function printKitchenTicket(db: Db, order: Order): Promise<PrintResult> {
  const queue = kitchenQueue()
  if (!queue) {
    await db
      .update(orders)
      .set({ printError: 'printer_not_configured' })
      .where(eq(orders.id, order.id))
    notifyOrdersChanged()
    return { ok: false, error: 'printer_not_configured' }
  }

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id))

  try {
    const pdf = await renderKitchenTicket(order, items, await loadSettings(db))
    await sendToCups(pdf, queue, `Order ${String(order.dailyNumber).padStart(3, '0')}`)
    const printedAt = Math.floor(Date.now() / 1000)
    await db
      .update(orders)
      .set({
        printedAt,
        printError: null,
        printAttempts: sql`${orders.printAttempts} + 1`,
      })
      .where(eq(orders.id, order.id))
    notifyOrdersChanged()
    return { ok: true, printedAt }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    await db
      .update(orders)
      .set({
        printError: detail.slice(0, 500),
        printAttempts: sql`${orders.printAttempts} + 1`,
      })
      .where(eq(orders.id, order.id))
    notifyOrdersChanged()
    return { ok: false, error: 'print_failed', detail }
  }
}
