import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/index.js'
import { users } from '../db/schema.js'
import { verifyPassword } from '../auth/password.js'
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
  }
}
