import { asc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { categories, orderItems, products, type OrderItem } from '../db/schema.js'

/**
 * An order's lines in MENU order: categories and products in the sequence the
 * Menu tab shows them, not the sequence the operator happened to tap them in.
 * Every printed document is read against the menu — the kitchen looks for the
 * antipasti block where the antipasti always are — so the sheet has to follow
 * the same order, whatever route the waiter took through the screen.
 *
 * The sort keys are read from the live menu rather than snapshotted onto the
 * line, because a ticket prints seconds after the order is taken (identical
 * either way) and a later reprint should match the menu people are reading
 * now. Prices and names stay snapshotted as before: what was charged is
 * history, the order things are listed in is presentation.
 *
 * The tie-breakers mirror routes/menu.ts exactly, so a sheet and the Menu tab
 * can never disagree, and orderItems.id keeps the result deterministic when a
 * category or product carries no explicit sort order.
 *
 * LEFT JOINs on purpose: a product with order lines is only ever soft-deleted
 * (routes/menu.ts hard-deletes only when nothing references it), but a line
 * must never vanish from a receipt even if that ever changes.
 */
export async function loadOrderItemsInMenuOrder(db: Db, orderId: number): Promise<OrderItem[]> {
  const rows = await db
    .select({ item: orderItems })
    .from(orderItems)
    .leftJoin(products, eq(products.id, orderItems.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(
      asc(categories.sortOrder),
      asc(categories.name),
      asc(products.sortOrder),
      asc(products.name),
      asc(orderItems.id),
    )
  return rows.map((r) => r.item)
}
