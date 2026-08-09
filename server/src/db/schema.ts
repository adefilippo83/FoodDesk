import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * Money is stored as integer cents everywhere. Never floats.
 */

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role', { enum: ['admin', 'maitre', 'operator', 'kitchen'] }).notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex('users_username_unique').on(t.username)],
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
)

export const categories = sqliteTable('categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  // Soft delete: historical orders must keep resolving their category.
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
})

export const products = sqliteTable(
  'products',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id),
    name: text('name').notNull(),
    priceCents: integer('price_cents').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    // Stock tracking (issue #31): null = untracked. Decremented on every
    // order; at zero the product deactivates itself.
    stockRemaining: integer('stock_remaining'),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => [index('products_category_id_idx').on(t.categoryId)],
)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const orders = sqliteTable(
  'orders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Human-facing sequence, reset per service day: "042"
    dailyNumber: integer('daily_number').notNull(),
    serviceDay: text('service_day').notNull(), // YYYY-MM-DD, local time
    // Mandatory for new orders (enforced in the route); old rows may be null.
    customerName: text('customer_name'),
    // Coperto: number of people and the per-person charge at order time.
    covers: integer('covers').notNull().default(1),
    coverChargeCents: integer('cover_charge_cents').notNull().default(0),
    // Cancelled orders keep their row and number forever — audit, not delete.
    cancelledAt: integer('cancelled_at'),
    cancelledBy: integer('cancelled_by').references(() => users.id),
    // Kitchen display: set when every item is done, cleared if one reopens.
    completedAt: integer('completed_at'),
    // Idempotency: a client-generated key so a network retry of the same
    // submission can never create a second order.
    clientKey: text('client_key'),
    note: text('note'),
    totalCents: integer('total_cents').notNull(),
    // Who placed it: staff orders carry the waiter's account; customer
    // self-ordering (phase A) has no staff author — createdBy stays null.
    origin: text('origin', { enum: ['staff', 'customer'] }).notNull().default('staff'),
    // Customers track their order by this unguessable token, never by id.
    publicToken: text('public_token'),
    // Payment: paidAt null = not (yet) paid. Online payments (phase B) set
    // the method and provider reference at creation and hold the order out
    // of the kitchen until the provider confirms; cash is set when marked
    // paid at the counter. refundedAt records the automatic refund when a
    // manager cancels an online-paid order.
    paidAt: integer('paid_at'),
    paymentMethod: text('payment_method', { enum: ['cash', 'stripe', 'paypal'] }),
    paymentRef: text('payment_ref'),
    refundedAt: integer('refunded_at'),
    createdBy: integer('created_by').references(() => users.id),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
    // Print state: an order is never lost because a printer jammed.
    printedAt: integer('printed_at'),
    printError: text('print_error'),
    printAttempts: integer('print_attempts').notNull().default(0),
  },
  (t) => [
    uniqueIndex('orders_day_number_unique').on(t.serviceDay, t.dailyNumber),
    // NULLs are distinct in SQLite, so key-less orders are unaffected.
    uniqueIndex('orders_client_key_unique').on(t.clientKey),
    uniqueIndex('orders_public_token_unique').on(t.publicToken),
    index('orders_created_by_idx').on(t.createdBy),
  ],
)

export const orderItems = sqliteTable(
  'order_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    // Snapshots: editing a product tomorrow must not rewrite tonight's receipt.
    nameSnapshot: text('name_snapshot').notNull(),
    priceCentsSnapshot: integer('price_cents_snapshot').notNull(),
    categoryNameSnapshot: text('category_name_snapshot').notNull(),
    qty: integer('qty').notNull(),
    note: text('note'),
    // Kitchen display: when the kitchen marked this line as prepared.
    doneAt: integer('done_at'),
    // Line-level cancellation: audited like order cancellation, never deleted.
    cancelledAt: integer('cancelled_at'),
    cancelledBy: integer('cancelled_by').references(() => users.id),
  },
  (t) => [index('order_items_order_id_idx').on(t.orderId)],
)

export type User = typeof users.$inferSelect
export type Role = User['role']
export type Category = typeof categories.$inferSelect
export type Product = typeof products.$inferSelect
export type Order = typeof orders.$inferSelect
export type OrderItem = typeof orderItems.$inferSelect
