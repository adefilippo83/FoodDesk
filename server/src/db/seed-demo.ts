import { createDb } from './index.js'
import { DEMO_PASSWORD, seedDemo } from './demoData.js'

/**
 * Loads the demo dataset into a database from the command line — a fresh
 * local instance to click around in. The public demo does NOT run this:
 * it resets itself in-process through POST /api/demo/reset (see
 * routes/demo.ts), which runs the very same seedDemo().
 */

const file = process.env.DATABASE_FILE ?? './data/fooddesk.db'
const { db, sqlite } = createDb(file)
try {
  const r = await seedDemo(db)
  console.log(
    `demo data ready: ${r.categories} categories, ${r.products} products, ` +
      `${r.orders} orders on ${r.serviceDay}, staff giulia/mario/lucia/cucina (password: ${DEMO_PASSWORD})`,
  )
} finally {
  sqlite.close()
}
