import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { createDb } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');
export async function makeTestApp() {
    const { db, sqlite } = createDb(':memory:');
    migrate(db, { migrationsFolder });
    const app = await buildApp(db, { logger: false, serveStatic: false });
    await app.ready();
    return { app, db, close: () => sqlite.close() };
}
export async function makeUser(db, username, role, password = 'password123', active = true) {
    const [row] = await db
        .insert(users)
        .values({
        username,
        passwordHash: await hashPassword(password),
        displayName: username,
        role,
        active,
    })
        .returning();
    return row;
}
/** Logs in and returns the session cookie header to replay on later requests. */
export async function login(app, username, password = 'password123') {
    const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username, password },
    });
    if (res.statusCode !== 200) {
        throw new Error(`login failed for ${username}: ${res.statusCode} ${res.body}`);
    }
    const cookie = res.cookies.find((c) => c.name === 'fd_session');
    if (!cookie)
        throw new Error('no session cookie set');
    return `fd_session=${cookie.value}`;
}
