import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { createDb, runMigrations } from './db/index.js'
import { purgeExpiredSessions } from './auth/session.js'
import { retryFailedPrints } from './print/service.js'
import { sweepHeldOrders, sweepStaleCounterOrders } from './payments/lifecycle.js'
import { providersFromEnv } from './payments/provider.js'

const DATABASE_FILE = process.env.DATABASE_FILE ?? './data/fooddesk.db'
const PORT = Number(process.env.PORT ?? 3000)
// Waiters connect from their phones, so bind all interfaces, not localhost.
const HOST = process.env.HOST ?? '0.0.0.0'

const { db, sqlite } = createDb(DATABASE_FILE)

// Migrations run at every boot: idempotent, and an update on the venue server
// becomes a plain restart with no separate migrate step to forget.
runMigrations({ db, sqlite }, resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle'))

const app = await buildApp(db)

await purgeExpiredSessions(db)
// Keep the session table tidy across a multi-day event, not just at boot.
setInterval(() => void purgeExpiredSessions(db).catch(() => {}), 60 * 60 * 1000).unref()

// A jammed or briefly offline printer must not swallow tickets: sweep for
// recent failed kitchen prints and retry them until they succeed or cap out.
setInterval(() => void retryFailedPrints(db, app.log).catch(() => {}), 30 * 1000).unref()

// Online payments: verify held orders whose customers closed the browser,
// and expire the ones that never paid.
const paymentProviders = providersFromEnv()
setInterval(
  () => void sweepHeldOrders(db, paymentProviders, app.log).catch(() => {}),
  30 * 1000,
).unref()

// Unpaid customer counter orders reserve stock but have no provider to expire
// them: reclaim the stock of ones the customer never came to pay for. Runs
// even with no payment providers configured (counter ordering can be on alone).
setInterval(
  () => void sweepStaleCounterOrders(db, app.log).catch(() => {}),
  60 * 1000,
).unref()

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down')
  await app.close()
  sqlite.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await app.listen({ port: PORT, host: HOST })
