import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createDb, runMigrations } from './index.js'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsFolder = resolve(here, '../../drizzle')

const file = process.env.DATABASE_FILE ?? './data/fooddesk.db'
const { db, sqlite } = createDb(file)
runMigrations({ db, sqlite }, migrationsFolder)
sqlite.close()
console.log(`migrations applied to ${file}`)
