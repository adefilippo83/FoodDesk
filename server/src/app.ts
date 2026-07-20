import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SESSION_COOKIE, resolveSession } from './auth/session.js'
import type { Db } from './db/index.js'
import { authRoutes } from './routes/auth.js'
import { menuRoutes } from './routes/menu.js'
import { orderRoutes } from './routes/orders.js'
import { reportRoutes } from './routes/reports.js'
import { settingsRoutes } from './routes/settings.js'
import { userRoutes } from './routes/users.js'

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public')

export async function buildApp(
  db: Db,
  opts: { logger?: boolean; serveStatic?: boolean } = {},
): Promise<FastifyInstance> {
  // bodyLimit: settings uploads carry base64 logo/background images in JSON.
  const app = Fastify({ logger: opts.logger ?? true, bodyLimit: 3 * 1024 * 1024 })

  await app.register(cookie)

  // Attach the session user before any route handler runs. This only
  // identifies the caller; authorization happens in the route guards.
  app.addHook('onRequest', async (req) => {
    const sid = req.cookies[SESSION_COOKIE]
    if (!sid) return
    const user = await resolveSession(db, sid)
    if (user) req.user = user
  })

  app.get('/api/health', async () => ({ ok: true }))

  await app.register(authRoutes(db))
  await app.register(userRoutes(db))
  await app.register(menuRoutes(db))
  await app.register(orderRoutes(db))
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
