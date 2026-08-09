import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as schema from './schema.js'

export function createDb(file: string) {
  if (file !== ':memory:') mkdirSync(dirname(resolve(file)), { recursive: true })
  const sqlite = new Database(file)
  // WAL keeps readers from blocking the writer during service.
  if (file !== ':memory:') sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  return { sqlite, db: drizzle(sqlite, { schema }) }
}

/**
 * The one correct way to run migrations. drizzle executes each migration
 * inside a transaction, where SQLite silently IGNORES the
 * "PRAGMA foreign_keys=OFF" that drizzle-kit writes into table-rebuild
 * migrations — so upgrading a database that rebuilds a referenced table
 * (e.g. orders, with order_items rows pointing at it) dies with a foreign
 * key violation on DROP TABLE. Disable enforcement on the connection for
 * the duration instead; the failed-migration transaction still rolls back
 * atomically either way.
 */
export function runMigrations(
  { db, sqlite }: ReturnType<typeof createDb>,
  migrationsFolder: string,
) {
  sqlite.pragma('foreign_keys = OFF')
  try {
    migrate(db, { migrationsFolder })
  } finally {
    sqlite.pragma('foreign_keys = ON')
  }
}

export type Db = ReturnType<typeof createDb>['db']
export { schema }
