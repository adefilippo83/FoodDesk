// Ensures an active kitchen-role account exists for kiosk mode and prints
// its username (and nothing else) on stdout. Run by rpi/firstboot.sh as the
// fooddesk user when KIOSK=kitchen. The generated password is random and
// never shown anywhere: the kiosk logs in via the loopback-only route, and
// an admin can set a real password from the Staff page if ever needed.
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { hashPassword } from '../server/dist/auth/password.js'
import { createDb, schema } from '../server/dist/db/index.js'

const { db, sqlite } = createDb(process.env.DATABASE_FILE ?? './data/fooddesk.db')

const existing = (
  await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.role, 'kitchen'))
).find((u) => u.active)

if (existing) {
  console.log(existing.username)
} else {
  await db.insert(schema.users).values({
    username: 'cucina',
    passwordHash: await hashPassword(randomBytes(24).toString('base64url')),
    displayName: 'Cucina',
    role: 'kitchen',
  })
  console.log('cucina')
}

sqlite.close()
