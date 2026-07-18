import { buildApp } from './app.js';
import { createDb } from './db/index.js';
import { purgeExpiredSessions } from './auth/session.js';
const DATABASE_FILE = process.env.DATABASE_FILE ?? './data/fooddesk.db';
const PORT = Number(process.env.PORT ?? 3000);
// Waiters connect from their phones, so bind all interfaces, not localhost.
const HOST = process.env.HOST ?? '0.0.0.0';
const { db, sqlite } = createDb(DATABASE_FILE);
const app = await buildApp(db);
await purgeExpiredSessions(db);
const shutdown = async (signal) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    sqlite.close();
    process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
await app.listen({ port: PORT, host: HOST });
