import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { Db } from '../db/index.js'
import { seedDemo } from '../db/demoData.js'
import { notifyOrdersChanged } from '../lib/events.js'

/**
 * The public demo's self-reset: POST /api/demo/reset wipes the database and
 * reloads the demo evening, in-process and in one transaction. It exists
 * only when DEMO_RESET_TOKEN is set — on a real venue's box the route is
 * simply not there. The token lives in the environment like the payment
 * keys: never in the database, never in its backups.
 */

/** Anything shorter is a guess away from wiping the demo on a schedule. */
export const DEMO_RESET_TOKEN_MIN_LENGTH = 32

/** The token from the environment, or null when unset or too weak to use. */
export function demoResetTokenFromEnv(log: FastifyBaseLogger): string | null {
  const token = process.env.DEMO_RESET_TOKEN
  if (!token) return null
  if (token.length < DEMO_RESET_TOKEN_MIN_LENGTH) {
    log.warn(
      `DEMO_RESET_TOKEN is shorter than ${DEMO_RESET_TOKEN_MIN_LENGTH} characters — demo reset endpoint disabled`,
    )
    return null
  }
  return token
}

/** Constant-time, and length-blind: both sides are hashed before comparing. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export function demoRoutes(db: Db, token: string) {
  return async function register(app: FastifyInstance) {
    app.post(
      '/api/demo/reset',
      // Guessing is throttled per IP on top of the token's length.
      { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const header = req.headers.authorization ?? ''
        const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
        if (!tokenMatches(presented, token)) {
          req.log.warn({ event: 'demo_reset_denied', ip: req.ip }, 'audit')
          return reply.code(401).send({ error: 'unauthorized' })
        }

        const result = await seedDemo(db)
        // Every open demo screen refetches: the evening just started over.
        notifyOrdersChanged()
        req.log.info({ event: 'demo_reset', ...result }, 'audit')
        return { ok: true, ...result }
      },
    )
  }
}
