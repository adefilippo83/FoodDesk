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
    role: text('role', { enum: ['admin', 'operator'] }).notNull(),
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
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => [index('products_category_id_idx').on(t.categoryId)],
)

export const orders = sqliteTable(
  'orders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Human-facing sequence, reset per service day: "042"
    dailyNumber: integer('daily_number').notNull(),
    serviceDay: text('service_day').notNull(), // YYYY-MM-DD, local time
    tableLabel: text('table_label'),
    note: text('note'),
    totalCents: integer('total_cents').notNull(),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
    // Print state: an order is never lost because a printer jammed.
    printedAt: integer('printed_at'),
    printError: text('print_error'),
    printAttempts: integer('print_attempts').notNull().default(0),
  },
  (t) => [
    uniqueIndex('orders_day_number_unique').on(t.serviceDay, t.dailyNumber),
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
  },
  (t) => [index('order_items_order_id_idx').on(t.orderId)],
)

export type User = typeof users.$inferSelect
export type Role = User['role']
export type Category = typeof categories.$inferSelect
export type Product = typeof products.$inferSelect
export type Order = typeof orders.$inferSelect
export type OrderItem = typeof orderItems.$inferSelect
