import { and, asc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { isManager, requireFloorStaff, requireManager } from '../auth/acl.js'
import type { Db } from '../db/index.js'
import { categories, orderItems, products } from '../db/schema.js'

function parseName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : null
}

/** Accepts "12.50" or 1250; always returns integer cents. */
function parsePriceCents(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  return null
}

export function menuRoutes(db: Db) {
  return async function register(app: FastifyInstance) {
    // ---- Reads: floor staff (kitchen accounts see only their display) ----

    app.get('/api/menu', { preHandler: requireFloorStaff }, async () => {
      const cats = await db
        .select()
        .from(categories)
        .where(eq(categories.active, true))
        .orderBy(asc(categories.sortOrder), asc(categories.name))
      const prods = await db
        .select()
        .from(products)
        .where(eq(products.active, true))
        .orderBy(asc(products.sortOrder), asc(products.name))

      return cats.map((c) => ({
        id: c.id,
        name: c.name,
        products: prods
          .filter((p) => p.categoryId === c.id)
          .map((p) => ({ id: p.id, name: p.name, priceCents: p.priceCents })),
      }))
    })

    app.get('/api/categories', { preHandler: requireFloorStaff }, async (req) => {
      const includeInactive =
        isManager(req.user!) && (req.query as { includeInactive?: string }).includeInactive === 'true'
      const rows = await db
        .select()
        .from(categories)
        .orderBy(asc(categories.sortOrder), asc(categories.name))
      return includeInactive ? rows : rows.filter((c) => c.active)
    })

    app.get('/api/products', { preHandler: requireFloorStaff }, async (req) => {
      const q = req.query as { categoryId?: string; includeInactive?: string }
      const includeInactive = isManager(req.user!) && q.includeInactive === 'true'
      const rows = await db
        .select()
        .from(products)
        .orderBy(asc(products.sortOrder), asc(products.name))
      return rows.filter(
        (p) =>
          (includeInactive || p.active) &&
          (q.categoryId === undefined || p.categoryId === Number(q.categoryId)),
      )
    })

    // ---- Writes: admin or maître d' ----

    app.post('/api/categories', { preHandler: requireManager }, async (req, reply) => {
      const body = req.body as Record<string, unknown> | undefined
      const name = parseName(body?.name)
      if (!name) return reply.code(400).send({ error: 'invalid_name' })
      const sortOrder = typeof body?.sortOrder === 'number' ? body.sortOrder : 0

      const created = (await db.insert(categories).values({ name, sortOrder }).returning())[0]!
      return reply.code(201).send(created)
    })

    app.patch('/api/categories/:id', { preHandler: requireManager }, async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const body = req.body as Record<string, unknown> | undefined
      const existing = (await db.select().from(categories).where(eq(categories.id, id)).limit(1))[0]
      if (!existing) return reply.code(404).send({ error: 'not_found' })

      const patch: Partial<typeof categories.$inferInsert> = {}
      if (body?.name !== undefined) {
        const name = parseName(body.name)
        if (!name) return reply.code(400).send({ error: 'invalid_name' })
        patch.name = name
      }
      if (typeof body?.sortOrder === 'number') patch.sortOrder = body.sortOrder
      if (typeof body?.active === 'boolean') patch.active = body.active
      if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'nothing_to_update' })

      const updated = (
        await db.update(categories).set(patch).where(eq(categories.id, id)).returning()
      )[0]!
      return updated
    })

    /**
     * Persist a drag-reorder: sortOrder becomes the index in the given list.
     * Ids not mentioned keep their old sortOrder, so a stale client cannot
     * scramble items it never saw.
     */
    for (const [path, table] of [
      ['/api/categories/order', categories],
      ['/api/products/order', products],
    ] as const) {
      app.put(path, { preHandler: requireManager }, async (req, reply) => {
        const ids = (req.body as { ids?: unknown } | undefined)?.ids
        if (
          !Array.isArray(ids) ||
          ids.length === 0 ||
          ids.length > 500 ||
          !ids.every((id) => Number.isInteger(id))
        ) {
          return reply.code(400).send({ error: 'invalid_ids' })
        }
        db.transaction((tx) => {
          ids.forEach((id: number, index) => {
            tx.update(table).set({ sortOrder: index }).where(eq(table.id, id)).run()
          })
        })
        return { ok: true }
      })
    }

    /**
     * Soft delete. Past orders reference this category by snapshot, but the
     * products inside it would otherwise linger on the menu with no home, so
     * they get hidden alongside it.
     */
    app.delete('/api/categories/:id', { preHandler: requireManager }, async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const existing = (await db.select().from(categories).where(eq(categories.id, id)).limit(1))[0]
      if (!existing) return reply.code(404).send({ error: 'not_found' })

      db.transaction((tx) => {
        tx.update(categories).set({ active: false }).where(eq(categories.id, id)).run()
        tx.update(products).set({ active: false }).where(eq(products.categoryId, id)).run()
      })
      return { ok: true, deactivatedCategory: id }
    })

    app.post('/api/products', { preHandler: requireManager }, async (req, reply) => {
      const body = req.body as Record<string, unknown> | undefined
      const name = parseName(body?.name)
      if (!name) return reply.code(400).send({ error: 'invalid_name' })

      const priceCents = parsePriceCents(body?.priceCents)
      if (priceCents === null) return reply.code(400).send({ error: 'invalid_price' })

      const categoryId = Number(body?.categoryId)
      const category = (
        await db.select().from(categories).where(eq(categories.id, categoryId)).limit(1)
      )[0]
      if (!category) return reply.code(400).send({ error: 'unknown_category' })

      const sortOrder = typeof body?.sortOrder === 'number' ? body.sortOrder : 0
      const created = (
        await db.insert(products).values({ name, priceCents, categoryId, sortOrder }).returning()
      )[0]!
      return reply.code(201).send(created)
    })

    app.patch('/api/products/:id', { preHandler: requireManager }, async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const body = req.body as Record<string, unknown> | undefined
      const existing = (await db.select().from(products).where(eq(products.id, id)).limit(1))[0]
      if (!existing) return reply.code(404).send({ error: 'not_found' })

      const patch: Partial<typeof products.$inferInsert> = {}
      if (body?.name !== undefined) {
        const name = parseName(body.name)
        if (!name) return reply.code(400).send({ error: 'invalid_name' })
        patch.name = name
      }
      if (body?.priceCents !== undefined) {
        const priceCents = parsePriceCents(body.priceCents)
        if (priceCents === null) return reply.code(400).send({ error: 'invalid_price' })
        patch.priceCents = priceCents
      }
      if (body?.categoryId !== undefined) {
        const categoryId = Number(body.categoryId)
        const category = (
          await db.select().from(categories).where(eq(categories.id, categoryId)).limit(1)
        )[0]
        if (!category) return reply.code(400).send({ error: 'unknown_category' })
        patch.categoryId = categoryId
      }
      if (typeof body?.sortOrder === 'number') patch.sortOrder = body.sortOrder
      if (typeof body?.active === 'boolean') patch.active = body.active
      if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'nothing_to_update' })

      const updated = (await db.update(products).set(patch).where(eq(products.id, id)).returning())[0]!
      if (patch.priceCents !== undefined && patch.priceCents !== existing.priceCents) {
        req.log.info(
          {
            event: 'price_changed',
            by: req.user!.id,
            productId: id,
            from: existing.priceCents,
            to: patch.priceCents,
          },
          'audit',
        )
      }
      return updated
    })

    app.delete('/api/products/:id', { preHandler: requireManager }, async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const existing = (await db.select().from(products).where(eq(products.id, id)).limit(1))[0]
      if (!existing) return reply.code(404).send({ error: 'not_found' })

      // Never hard-delete something an order line points at.
      const used = (
        await db
          .select({ id: orderItems.id })
          .from(orderItems)
          .where(eq(orderItems.productId, id))
          .limit(1)
      )[0]
      if (used) {
        await db.update(products).set({ active: false }).where(eq(products.id, id))
        return { ok: true, deactivated: true }
      }

      await db.delete(products).where(and(eq(products.id, id)))
      return { ok: true, deleted: true }
    })
  }
}
