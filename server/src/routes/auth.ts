import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/index.js'
import { users } from '../db/schema.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { clearFailures, isBlocked, recordFailure } from '../auth/lockout.js'
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSession,
  destroySession,
} from '../auth/session.js'
import { requireAuth } from '../auth/acl.js'
import { sessions } from '../db/schema.js'
import { and, ne } from 'drizzle-orm'

// Verified against when the username does not exist, so a login for a missing
// user costs the same ~scrypt time as one for a real user — no timing oracle.
const DUMMY_HASH = await hashPassword('timing-equalizer')

export function authRoutes(db: Db) {
  return async function register(app: FastifyInstance) {
    // Generous for a venue full of phones (each has its own LAN IP behind
    // nginx), tight enough that one machine cannot hammer scrypt.
    app.post(
      '/api/auth/login',
      { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (req, reply) => {
      const body = req.body as { username?: unknown; password?: unknown } | undefined
      const username = typeof body?.username === 'string' ? body.username.trim() : ''
      const password = typeof body?.password === 'string' ? body.password : ''
      if (!username || !password) {
        return reply.code(400).send({ error: 'username_and_password_required' })
      }

      if (isBlocked(req.ip, username)) {
        req.log.warn({ event: 'login_blocked', username, ip: req.ip }, 'audit')
        return reply.code(429).send({ error: 'too_many_attempts' })
      }

      const row = (await db.select().from(users).where(eq(users.username, username)).limit(1))[0]

      // Same response whether the user is missing, inactive, or the password is
      // wrong — no probing for valid usernames.
      const ok =
        row && row.active
          ? await verifyPassword(password, row.passwordHash)
          : (await verifyPassword(password, DUMMY_HASH), false)
      if (!row || !ok) {
        const nowBlocked = recordFailure(req.ip, username)
        req.log.warn(
          { event: nowBlocked ? 'login_lockout' : 'login_failed', username, ip: req.ip },
          'audit',
        )
        return reply.code(401).send({ error: 'invalid_credentials' })
      }

      clearFailures(req.ip, username)
      req.log.info({ event: 'login_ok', userId: row.id, username, ip: req.ip }, 'audit')

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
    app.post(
      '/api/auth/password',
      {
        preHandler: requireAuth,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
      const body = req.body as { currentPassword?: unknown; newPassword?: unknown } | undefined
      const current = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
      const next = typeof body?.newPassword === 'string' ? body.newPassword : ''

      if (next.length < 8) {
        return reply.code(400).send({ error: 'password_too_short', minLength: 8 })
      }
      if (!(await verifyPassword(current, req.user!.passwordHash))) {
        req.log.warn(
          { event: 'password_change_denied', userId: req.user!.id, ip: req.ip },
          'audit',
        )
        return reply.code(403).send({ error: 'wrong_password' })
      }

      await db
        .update(users)
        .set({ passwordHash: await hashPassword(next) })
        .where(eq(users.id, req.user!.id))

      // A password change evicts every other device: if the change was made
      // because a phone went missing, that phone is now signed out.
      const currentSid = req.cookies[SESSION_COOKIE] ?? ''
      await db
        .delete(sessions)
        .where(and(eq(sessions.userId, req.user!.id), ne(sessions.id, currentSid)))

      req.log.info({ event: 'password_changed', userId: req.user!.id, ip: req.ip }, 'audit')
      return { ok: true }
    })
  }
}
