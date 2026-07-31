import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { createDb } from './index.js'
import { sessions, users } from './schema.js'

const file = process.env.DATABASE_FILE ?? './data/fooddesk.db'
const { db, sqlite } = createDb(file)

const username = process.env.ADMIN_USERNAME ?? 'admin'
const existing = (
  await db.select().from(users).where(eq(users.username, username)).limit(1)
)[0]

if (existing) {
  // An existing database keeps its admin untouched — unless ADMIN_PASSWORD
  // is explicitly set AND differs, in which case this doubles as an
  // emergency password reset (issue #29). The "differs" check matters: the
  // Docker entrypoint runs this at every boot, and an unconditional reset
  // would evict the admin's sessions on every restart.
  const wanted = process.env.ADMIN_PASSWORD
  if (wanted && !(await verifyPassword(wanted, existing.passwordHash))) {
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(wanted) })
      .where(eq(users.id, existing.id))
    await db.delete(sessions).where(eq(sessions.userId, existing.id))
    console.log(`\n  Admin user "${username}" password reset from ADMIN_PASSWORD`)
    console.log('  All admin sessions have been signed out.\n')
  } else {
    console.log(`admin user "${username}" already exists — nothing to do`)
  }
} else {
  // Generated, not hardcoded: a shipped default password is a live account.
  const password = process.env.ADMIN_PASSWORD ?? randomBytes(9).toString('base64url')
  await db.insert(users).values({
    username,
    passwordHash: await hashPassword(password),
    displayName: 'Administrator',
    role: 'admin',
  })
  console.log('\n  Admin account created')
  console.log(`  username: ${username}`)
  console.log(`  password: ${password}`)
  console.log('\n  Change this password after first login.\n')
}

sqlite.close()
