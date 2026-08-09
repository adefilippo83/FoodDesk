import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireAuth } from './auth/acl.js'
import { SESSION_COOKIE, resolveSession } from './auth/session.js'
import { ordersBus } from './lib/events.js'
import type { Db } from './db/index.js'
import { authRoutes } from './routes/auth.js'
import { kitchenRoutes } from './routes/kitchen.js'
import { menuRoutes } from './routes/menu.js'
import { orderRoutes } from './routes/orders.js'
import { publicRoutes } from './routes/public.js'
import { reportRoutes } from './routes/reports.js'
import { settingsRoutes } from './routes/settings.js'
import { userRoutes } from './routes/users.js'

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public')

export async function buildApp(
  db: Db,
  opts: { logger?: boolean; serveStatic?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? true,
    // Orders and menu edits are tiny; the one route that legitimately carries
    // megabytes (settings image uploads) raises its own limit. Everything else
    // rejecting large bodies early blunts memory-pressure abuse.
    bodyLimit: 64 * 1024,
    // Only the local nginx may speak for the client's address — a LAN client
    // cannot spoof X-Forwarded-For to dodge the login lockout.
    trustProxy: '127.0.0.1',
  })

  await app.register(cookie)
  // Not global: only the routes doing expensive scrypt work (login, password
  // change) opt in, capping how fast one IP can burn CPU on them. The
  // per-username lockout still handles targeted guessing.
  await app.register(rateLimit, { global: false })

  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    // React writes inline style attributes; the print iframe uses an inline <style>.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; ')

  app.addHook('onSend', async (_req, reply) => {
    reply.header('content-security-policy', CSP)
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'SAMEORIGIN')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
  })

  // Belt-and-braces CSRF guard on top of SameSite=Lax: a state-changing
  // request whose Origin disagrees with the Host it reached is not ours.
  // Requests without an Origin header (curl, native clients) pass — CSRF is
  // a browser-borne attack and browsers always send Origin on those methods.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
    const origin = req.headers.origin
    if (!origin) return
    // URL() drops default ports from .host while the Host header keeps them —
    // normalize both sides or same-origin requests on port 80/443 would fail.
    const normalize = (h: string) => h.replace(/:(80|443)$/, '')
    let originHost: string
    try {
      originHost = normalize(new URL(origin).host)
    } catch {
      return reply.code(403).send({ error: 'bad_origin' })
    }
    if (originHost !== normalize(req.headers.host ?? '')) {
      req.log.warn({ event: 'origin_mismatch', origin, host: req.headers.host }, 'audit')
      return reply.code(403).send({ error: 'bad_origin' })
    }
  })

  // Attach the session user before any route handler runs. This only
  // identifies the caller; authorization happens in the route guards.
  app.addHook('onRequest', async (req) => {
    const sid = req.cookies[SESSION_COOKIE]
    if (!sid) return
    const user = await resolveSession(db, sid)
    if (user) req.user = user
  })

  app.get('/api/health', async () => ({ ok: true }))

  /**
   * Server-sent events: a bare "orders" ping whenever orders change, so
   * screens refetch immediately instead of leaning on their polling loop.
   * EventSource reconnects on its own; polling stays as the safety net.
   */
  app.get('/api/events', { preHandler: requireAuth }, (req, reply) => {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      // Tells nginx not to buffer this response.
      'x-accel-buffering': 'no',
    })
    raw.write('retry: 3000\n\n')

    const onOrders = () => raw.write('event: orders\ndata: {}\n\n')
    ordersBus.on('orders', onOrders)
    // Comment frames keep idle proxies from timing the stream out.
    const heartbeat = setInterval(() => raw.write(': keep-alive\n\n'), 25_000)
    heartbeat.unref()

    req.raw.on('close', () => {
      clearInterval(heartbeat)
      ordersBus.off('orders', onOrders)
    })
  })

  await app.register(authRoutes(db))
  await app.register(userRoutes(db))
  await app.register(menuRoutes(db))
  await app.register(orderRoutes(db))
  await app.register(publicRoutes(db))
  await app.register(kitchenRoutes(db))
  await app.register(reportRoutes(db))
  await app.register(settingsRoutes(db))

  // In production the built React app is served from the same origin as the
  // API, so waiters only ever need one address on the venue Wi-Fi.
  if (opts.serveStatic ?? existsSync(PUBLIC_DIR)) {
    await app.register(fastifyStatic, { root: PUBLIC_DIR })
    // Client-side routing: anything that is not an API call falls back to the
    // SPA shell so a refresh on /orders does not 404.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' })
      return reply.sendFile('index.html')
    })
  }

  return app
}
