import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { requireManager } from '../auth/acl.js'
import type { Db } from '../db/index.js'
import { hashPassword } from '../auth/password.js'
import { sessions, users, type Role } from '../db/schema.js'

const ROLES: Role[] = ['admin', 'maitre', 'operator', 'kitchen']

export function userRoutes(db: Db) {
  return async function register(app: FastifyInstance) {
    // Admin or maître d'. A maître is further restricted below: they may only
    // create waiters and only modify waiters — never admins or other maîtres,
    // and never roles. Their own password goes through /api/auth/password.
    app.addHook('preHandler', requireManager)

    app.get('/api/users', async () => {
      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          role: users.role,
          active: users.active,
          createdAt: users.createdAt,
        })
        .from(users)
      return rows
    })

    app.post('/api/users', async (req, reply) => {
      const body = req.body as Record<string, unknown> | undefined
      const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : ''
      const password = typeof body?.password === 'string' ? body.password : ''
      const displayName =
        typeof body?.displayName === 'string' && body.displayName.trim()
          ? body.displayName.trim()
          : username
      const role = body?.role as Role

      if (!username || !password) {
        return reply.code(400).send({ error: 'username_and_password_required' })
      }
      if (password.length < 8) {
        return reply.code(400).send({ error: 'password_too_short', minLength: 8 })
      }
      if (!ROLES.includes(role)) {
        return reply.code(400).send({ error: 'invalid_role', allowed: ROLES })
      }
      // A maître d' may only create waiters — not admins, other maîtres, nor
      // kitchen accounts (those are the admin's call).
      if (req.user!.role === 'maitre' && role !== 'operator') {
        req.log.warn(
          { event: 'maitre_denied', by: req.user!.id, action: 'create', role },
          'audit',
        )
        return reply.code(403).send({ error: 'forbidden' })
      }

      const existing = (
        await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1)
      )[0]
      if (existing) return reply.code(409).send({ error: 'username_taken' })

      const inserted = (
        await db
          .insert(users)
          .values({ username, passwordHash: await hashPassword(password), displayName, role })
          .returning({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            role: users.role,
            active: users.active,
          })
      )[0]!
      req.log.info(
        { event: 'user_created', by: req.user!.id, userId: inserted.id, role: inserted.role },
        'audit',
      )
      return reply.code(201).send(inserted)
    })

    app.patch('/api/users/:id', async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      const body = req.body as Record<string, unknown> | undefined
      const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
      if (!target) return reply.code(404).send({ error: 'not_found' })

      // A maître may only touch waiter accounts, and may not reassign roles
      // at all — no promoting anyone (or themselves) upward.
      if (req.user!.role === 'maitre' && (target.role !== 'operator' || body?.role !== undefined)) {
        req.log.warn(
          { event: 'maitre_denied', by: req.user!.id, action: 'update', targetId: id },
          'audit',
        )
        return reply.code(403).send({ error: 'forbidden' })
      }

      const patch: Partial<typeof users.$inferInsert> = {}
      if (typeof body?.displayName === 'string' && body.displayName.trim()) {
        patch.displayName = body.displayName.trim()
      }
      if (typeof body?.password === 'string') {
        if (body.password.length < 8) {
          return reply.code(400).send({ error: 'password_too_short', minLength: 8 })
        }
        patch.passwordHash = await hashPassword(body.password)
      }
      if (body?.role !== undefined) {
        if (!ROLES.includes(body.role as Role)) {
          return reply.code(400).send({ error: 'invalid_role', allowed: ROLES })
        }
        patch.role = body.role as Role
      }
      if (typeof body?.active === 'boolean') patch.active = body.active

      // Guard against an admin locking everyone out of the admin surface.
      const losingAdmin =
        target.role === 'admin' &&
        ((patch.role !== undefined && patch.role !== 'admin') || patch.active === false)
      if (losingAdmin) {
        const admins = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, 'admin'), eq(users.active, true)))
        if (admins.length <= 1) {
          return reply.code(409).send({ error: 'last_admin' })
        }
      }

      if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'nothing_to_update' })

      const updated = (
        await db.update(users).set(patch).where(eq(users.id, id)).returning({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          role: users.role,
          active: users.active,
        })
      )[0]!

      // A reset password or a disabled account signs the user out everywhere.
      if (patch.passwordHash !== undefined || patch.active === false) {
        await db.delete(sessions).where(eq(sessions.userId, id))
      }

      req.log.info(
        {
          event: 'user_updated',
          by: req.user!.id,
          userId: id,
          fields: Object.keys(patch).map((k) => (k === 'passwordHash' ? 'password' : k)),
        },
        'audit',
      )
      return updated
    })
  }
}
