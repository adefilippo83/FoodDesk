import { randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { sessions, users } from '../db/schema.js';
export const SESSION_COOKIE = 'fd_session';
// A service runs all evening; a shift-length session avoids re-logins mid-rush.
export const SESSION_TTL_SECONDS = 16 * 60 * 60;
export async function createSession(db, userId) {
    const id = randomBytes(32).toString('base64url');
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    await db.insert(sessions).values({ id, userId, expiresAt });
    return id;
}
export async function resolveSession(db, id) {
    const now = Math.floor(Date.now() / 1000);
    const rows = await db
        .select({ user: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now)))
        .limit(1);
    const user = rows[0]?.user;
    // A deactivated account loses access immediately, session or not.
    if (!user || !user.active)
        return null;
    return user;
}
export async function destroySession(db, id) {
    await db.delete(sessions).where(eq(sessions.id, id));
}
export async function purgeExpiredSessions(db) {
    await db.delete(sessions).where(lt(sessions.expiresAt, Math.floor(Date.now() / 1000)));
}
