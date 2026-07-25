import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { login, makeTestApp, makeUser } from './helpers.js'

/**
 * The maître d' (caposala) contract: admin powers over the menu, every order
 * and the reports — but no Settings, and staff management limited to waiters.
 */
describe("maître d'", () => {
  let app: FastifyInstance
  let close: () => void
  let maitreCookie: string
  let adminId: number
  let maitre2Id: number
  let waiterId: number
  let waiterCookie: string

  before(async () => {
    const t = await makeTestApp()
    app = t.app
    close = t.close
    adminId = (await makeUser(t.db, 'admin', 'admin'))!.id
    await makeUser(t.db, 'giulia', 'maitre')
    maitre2Id = (await makeUser(t.db, 'other-maitre', 'maitre'))!.id
    waiterId = (await makeUser(t.db, 'marco', 'operator'))!.id
    maitreCookie = await login(app, 'giulia')
    waiterCookie = await login(app, 'marco')
  })

  after(() => {
    void app.close()
    close()
  })

  // ---- staff ----

  it('creates a waiter but not an admin or another maître', async () => {
    const waiter = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: maitreCookie },
      payload: { username: 'nuovo', password: 'password123', role: 'operator' },
    })
    assert.equal(waiter.statusCode, 201)

    for (const role of ['admin', 'maitre', 'kitchen']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { cookie: maitreCookie },
        payload: { username: `sneaky-${role}`, password: 'password123', role },
      })
      assert.equal(res.statusCode, 403, `creating a ${role} must be forbidden`)
    }
  })

  it('resets a waiter password but not an admin or another maître', async () => {
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/users/${waiterId}`,
      headers: { cookie: maitreCookie },
      payload: { password: 'newpassword1' },
    })
    assert.equal(ok.statusCode, 200)

    for (const id of [adminId, maitre2Id]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${id}`,
        headers: { cookie: maitreCookie },
        payload: { password: 'hijacked123' },
      })
      assert.equal(res.statusCode, 403)
    }
  })

  it('cannot change roles, even on a waiter', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${waiterId}`,
      headers: { cookie: maitreCookie },
      payload: { role: 'admin' },
    })
    assert.equal(res.statusCode, 403)
  })

  it('changes their own password via the self-service route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: maitreCookie },
      payload: { currentPassword: 'password123', newPassword: 'freshpass456' },
    })
    assert.equal(res.statusCode, 200)
  })

  // ---- settings ----

  it('is locked out of settings, read and write', async () => {
    for (const [method, url] of [
      ['GET', '/api/settings'],
      ['PUT', '/api/settings'],
      ['GET', '/api/settings/preview.pdf'],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: maitreCookie },
        ...(method === 'PUT' ? { payload: { restaurantName: 'X' } } : {}),
      })
      assert.equal(res.statusCode, 403, `${method} ${url} must be forbidden`)
    }
  })

  // ---- menu, orders, reports: like an admin ----

  it('manages the menu like an admin', async () => {
    const cat = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { cookie: maitreCookie },
      payload: { name: 'Drinks' },
    })
    assert.equal(cat.statusCode, 201)
    const prod = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { cookie: maitreCookie },
      payload: { name: 'Beer', priceCents: 500, categoryId: cat.json().id },
    })
    assert.equal(prod.statusCode, 201)
  })

  it("sees every waiter's order and can cancel one", async () => {
    const prods = await app.inject({
      method: 'GET',
      url: '/api/products',
      headers: { cookie: maitreCookie },
    })
    const beerId = prods.json()[0].id
    // The password-reset test above evicted marco's session — sign in again.
    waiterCookie = await login(app, 'marco', 'newpassword1')
    const order = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: waiterCookie },
      payload: { customerName: 'Rossi', items: [{ productId: beerId, qty: 1 }] },
    })
    assert.equal(order.statusCode, 201)
    const id = order.json().id

    const detail = await app.inject({
      method: 'GET',
      url: `/api/orders/${id}`,
      headers: { cookie: maitreCookie },
    })
    assert.equal(detail.statusCode, 200, "maître must read a waiter's order")

    const list = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: maitreCookie },
    })
    assert.ok(list.json().orders.some((o: { id: number }) => o.id === id))

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/orders/${id}/cancel`,
      headers: { cookie: maitreCookie },
    })
    assert.equal(cancelled.statusCode, 200)
    assert.ok(cancelled.json().cancelledAt)
  })

  it('reads the daily report', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/daily',
      headers: { cookie: maitreCookie },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(typeof res.json().revenueCents, 'number')
  })
})
