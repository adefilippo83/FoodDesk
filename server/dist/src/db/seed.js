import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../auth/password.js';
import { createDb } from './index.js';
import { users } from './schema.js';
const file = process.env.DATABASE_FILE ?? './data/fooddesk.db';
const { db, sqlite } = createDb(file);
const username = process.env.ADMIN_USERNAME ?? 'admin';
const existing = (await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1))[0];
if (existing) {
    console.log(`admin user "${username}" already exists — nothing to do`);
}
else {
    // Generated, not hardcoded: a shipped default password is a live account.
    const password = process.env.ADMIN_PASSWORD ?? randomBytes(9).toString('base64url');
    await db.insert(users).values({
        username,
        passwordHash: await hashPassword(password),
        displayName: 'Administrator',
        role: 'admin',
    });
    console.log('\n  Admin account created');
    console.log(`  username: ${username}`);
    console.log(`  password: ${password}`);
    console.log('\n  Change this password after first login.\n');
}
sqlite.close();
