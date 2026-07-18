import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema.js';
export function createDb(file) {
    if (file !== ':memory:')
        mkdirSync(dirname(resolve(file)), { recursive: true });
    const sqlite = new Database(file);
    // WAL keeps readers from blocking the writer during service.
    if (file !== ':memory:')
        sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    return { sqlite, db: drizzle(sqlite, { schema }) };
}
export { schema };
