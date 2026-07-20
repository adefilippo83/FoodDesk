import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/index.js'
import { users } from '../db/schema.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSession,
  destroySession,
} from '../auth/session.js'
import { requireAuth } from '../auth/acl.js'

export function authRoutes(db: Db) {
  return async function register(app: FastifyInstance) {
    app.post('/api/auth/login', async (req, reply) => {
      const body = req.body as { username?: unknown; password?: unknown } | undefined
      const username = typeof body?.username === 'string' ? body.username.trim() : ''
      const password = typeof body?.password === 'string' ? body.password : ''
      if (!username || !password) {
        return reply.code(400).send({ error: 'username_and_password_required' })
      }

      const row = (await db.select().from(users).where(eq(users.username, username)).limit(1))[0]

      // Same response whether the user is missing, inactive, or the password is
      // wrong — no probing for valid usernames.
      const ok = row && row.active ? await verifyPassword(password, row.passwordHash) : false
      if (!row || !ok) {
        return reply.code(401).send({ error: 'invalid_credentials' })
      }

      const sid = await createSession(db, row.id)
      reply.setCookie(SESSION_COOKIE, sid, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: SESSION_TTL_SECONDS,
        // Venue LAN is plain http; flip on when served over TLS.
        secure: process.env.COOKIE_SECURE === 'true',
      })
      return { id: row.id, username: row.username, displayName: row.displayName, role: row.role }
    })

    app.post('/api/auth/logout', async (req, reply) => {
      const sid = req.cookies[SESSION_COOKIE]
      if (sid) await destroySession(db, sid)
      reply.clearCookie(SESSION_COOKIE, { path: '/' })
      return { ok: true }
    })

    app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
      const u = req.user!
      return { id: u.id, username: u.username, displayName: u.displayName, role: u.role }
    })

    /** Self-service password change — current password required, any role. */
    app.post('/api/auth/password', { preHandler: requireAuth }, async (req, reply) => {
      const body = req.body as { currentPassword?: unknown; newPassword?: unknown } | undefined
      const current = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
      const next = typeof body?.newPassword === 'string' ? body.newPassword : ''

      if (next.length < 8) {
        return reply.code(400).send({ error: 'password_too_short', minLength: 8 })
      }
      if (!(await verifyPassword(current, req.user!.passwordHash))) {
        return reply.code(403).send({ error: 'wrong_password' })
      }

      await db
        .update(users)
        .set({ passwordHash: await hashPassword(next) })
        .where(eq(users.id, req.user!.id))
      return { ok: true }
    })
  }
}
