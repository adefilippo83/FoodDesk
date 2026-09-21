import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { Db } from '../src/db/index.js'
import { seedDemo } from '../src/db/demoData.js'
import { categories, orders, products, sessions, users } from '../src/db/schema.js'
import { login, makeTestApp, makeUser } from './helpers.js'

/**
 * The public demo's self-reset (POST /api/demo/reset): present only when a
 * token is configured, accepts only that token, replaces everything but the
 * admin in one transaction, and signs everyone out. Each test gets its own
 * app: the endpoint is rate-limited per IP, and that limit is part of what
 * is under test.
 */

const TOKEN = 'demo-reset-test-token-0123456789abcdef'

type Rig = {
  app: FastifyInstance
  db: Db
  adminCookie: string
  reset: (token?: string) => Promise<LightMyRequestResponse>
  count: (table: SQLiteTable) => Promise<number>
  done: () => Promise<void>
}

async function rig(opts: Parameters<typeof makeTestApp>[0] = { demoResetToken: TOKEN }): Promise<Rig> {
  const t = await makeTestApp(opts)
  await makeUser(t.db, 'admin', 'admin')
  const adminCookie = await login(t.app, 'admin')
  return {
    app: t.app,
    db: t.db,
    adminCookie,
    reset: (token?: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/demo/reset',
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      }),
    count: async (table) => (await t.db.select().from(table)).length,
    done: async () => {
      await t.app.close()
      t.close()
    },
  }
}

describe('demo reset endpoint', () => {
  it('is not there at all without a configured token', async () => {
    const r = await rig({ demoResetToken: null })
    assert.equal((await r.reset(TOKEN)).statusCode, 404)
    await r.done()
  })

  it('refuses a token too short to be safe, from the environment', async () => {
    const prev = process.env.DEMO_RESET_TOKEN
    process.env.DEMO_RESET_TOKEN = 'short'
    try {
      const r = await rig({})
      assert.equal((await r.reset('short')).statusCode, 404)
      await r.done()
    } finally {
      if (prev === undefined) delete process.env.DEMO_RESET_TOKEN
      else process.env.DEMO_RESET_TOKEN = prev
    }
  })

  it('rejects a missing or wrong token and touches nothing', async () => {
    const r = await rig()
    // Something to lose.
    const cat = await r.app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { cookie: r.adminCookie },
      payload: { name: 'Keep me' },
    })
    assert.equal(cat.statusCode, 201)

    assert.equal((await r.reset()).statusCode, 401)
    assert.equal((await r.reset('')).statusCode, 401)
    assert.equal((await r.reset(TOKEN.slice(0, -1))).statusCode, 401)
    assert.equal((await r.reset(`${TOKEN}x`)).statusCode, 401)
    assert.equal((await r.reset(TOKEN.toUpperCase())).statusCode, 401)

    const kept = await r.db.select().from(categories).where(eq(categories.name, 'Keep me'))
    assert.equal(kept.length, 1, 'a refused reset must not wipe anything')
    await r.done()
  })

  it('throttles guessing: the sixth attempt in a minute is refused outright', async () => {
    const r = await rig()
    for (let i = 0; i < 5; i++) assert.equal((await r.reset('wrong')).statusCode, 401)
    assert.equal((await r.reset('wrong')).statusCode, 429)
    // Even the right token waits — the limit is per IP, not per outcome.
    assert.equal((await r.reset(TOKEN)).statusCode, 429)
    await r.done()
  })

  it('replaces the data, keeps the admin, and signs everyone out', async () => {
    const r = await rig()
    await r.app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { cookie: r.adminCookie },
      payload: { name: 'Old menu' },
    })
    const adminBefore = (await r.db.select().from(users).where(eq(users.username, 'admin')))[0]!

    const res = await r.reset(TOKEN)
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.categories, 7)
    assert.equal(body.products, 20)
    assert.equal(body.orders, 7)
    assert.match(body.serviceDay, /^\d{4}-\d{2}-\d{2}$/)

    // The demo evening is in, the old category is gone.
    assert.equal(await r.count(categories), 7)
    assert.equal(await r.count(products), 20)
    assert.equal(await r.count(orders), 7)
    assert.equal((await r.db.select().from(categories).where(eq(categories.name, 'Old menu'))).length, 0)

    // The admin survived with the same password hash; the demo staff is in.
    const adminAfter = (await r.db.select().from(users).where(eq(users.username, 'admin')))[0]!
    assert.equal(adminAfter.id, adminBefore.id)
    assert.equal(adminAfter.passwordHash, adminBefore.passwordHash)
    const names = (await r.db.select().from(users)).map((u) => u.username).sort()
    assert.deepEqual(names, ['admin', 'cucina', 'giulia', 'lucia', 'mario'])

    // Sessions are evicted: the cookie from before the reset is dead.
    assert.equal(await r.count(sessions), 0)
    const me = await r.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: r.adminCookie } })
    assert.equal(me.statusCode, 401)

    // The demo staff can sign in with the documented password.
    const mario = await r.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'mario', password: 'fooddesk-demo' },
    })
    assert.equal(mario.statusCode, 200)
    await r.done()
  })

  it('shows the register split in the demo report (cash, POS, unpaid self-order)', async () => {
    const r = await rig()
    assert.equal((await r.reset(TOKEN)).statusCode, 200)
    const cookie = await login(r.app, 'admin')
    const report = await r.app.inject({ method: 'GET', url: '/api/reports/daily', headers: { cookie } })
    assert.equal(report.statusCode, 200)
    const methods = report
      .json()
      .byPayment.map((b: { method: string }) => b.method)
      .sort()
    // 'counter' is the unpaid self-order (no method yet); cash and POS come
    // from the staff orders — the report page has the split to show.
    assert.deepEqual(methods, ['cash', 'counter', 'pos'])
    await r.done()
  })

  it('is idempotent: a second reset yields the same dataset, no duplicates', async () => {
    const r = await rig()
    const first = (await r.reset(TOKEN)).json()
    const second = (await r.reset(TOKEN)).json()
    assert.deepEqual(second, first)
    assert.equal(await r.count(categories), 7)
    assert.equal(await r.count(products), 20)
    assert.equal(await r.count(orders), 7)
    assert.equal(await r.count(users), 5)
    await r.done()
  })

  it('is all-or-nothing: a failure midway leaves the previous dataset intact', async () => {
    const r = await rig()
    assert.equal((await r.reset(TOKEN)).statusCode, 200)
    const snapshot = async () => ({
      categories: await r.count(categories),
      products: await r.count(products),
      orders: await r.count(orders),
      users: await r.count(users),
    })
    const before = await snapshot()
    // Sabotage: a product table that will not take the demo's rows. The
    // wipe at the start of the seed must roll back with the failed insert.
    r.db.run('CREATE TRIGGER sabotage BEFORE INSERT ON products BEGIN SELECT RAISE(ABORT, "sabotage"); END')
    try {
      await assert.rejects(seedDemo(r.db), /sabotage/)
    } finally {
      r.db.run('DROP TRIGGER sabotage')
    }
    assert.deepEqual(await snapshot(), before, 'a failed reset must not leave an empty demo')
    await r.done()
  })
})
