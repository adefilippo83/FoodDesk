import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { orderItems, orders, type Order } from '../db/schema.js'
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
export async function printKitchenTicket(db: Db, order: Order): Promise<PrintResult> {
  const queue = kitchenQueue()
  if (!queue) {
    await db
      .update(orders)
      .set({ printError: 'printer_not_configured' })
      .where(eq(orders.id, order.id))
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
    return { ok: false, error: 'print_failed', detail }
  }
}
