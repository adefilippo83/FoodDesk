// Boots the compiled server against a throwaway database for the e2e suite.
// Requires a prior `npm run build` (server/dist + server/public).
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const tmp = fileURLToPath(new URL('./.tmp', import.meta.url))
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

process.env.DATABASE_FILE = `${tmp}/fooddesk-e2e.db`
process.env.HOST = '127.0.0.1'
process.env.PORT = '3100'
process.env.ADMIN_USERNAME = 'admin'
process.env.ADMIN_PASSWORD = 'playwright123'
// A configured (nonexistent) queue keeps the browser print dialog out of the
// test flow; the failed CUPS job is recorded on the order, which is fine.
process.env.KITCHEN_PRINTER = 'e2e-null-queue'

// Each script opens and closes its own DB handle; order matters.
await import('../server/dist/db/migrate.js')
await import('../server/dist/db/seed.js')
await import('../server/dist/index.js')
