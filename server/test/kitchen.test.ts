import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { login, makeTestApp, makeUser } from './helpers.js'

/**
 * Kitchen display contract: kitchen accounts see today's active orders and
 * toggle items done — and can reach nothing else. When the last item of an
 * order is done, the order itself is completed; reopening an item un-completes it.
 */
describe('kitchen display', () => {
  let app: FastifyInstance
  let close: () => void
  let adminCookie: string
  let maitreCookie: string
  let waiterCookie: string
  let chefCookie: string
  let orderId: number
  let itemIds: number[]

  before(async () => {
    const t = await makeTestApp()
    app = t.app
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    await makeUser(t.db, 'giulia', 'maitre')
    await makeUser(t.db, 'marco', 'operator')
    await makeUser(t.db, 'chef', 'kitchen')
    adminCookie = await login(app, 'admin')
    maitreCookie = await login(app, 'giulia')
    waiterCookie = await login(app, 'marco')
    chefCookie = await login(app, 'chef')

    const cat = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { cookie: adminCookie },
      payload: { name: 'Drinks' },
    })
    const beer = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { cookie: adminCookie },
      payload: { name: 'Beer', priceCents: 500, categoryId: cat.json().id },
    })
    const wine = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { cookie: adminCookie },
      payload: { name: 'Wine', priceCents: 750, categoryId: cat.json().id },
    })
    const order = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: waiterCookie },
      payload: {
        customerName: 'Rossi',
        items: [
          { productId: beer.json().id, qty: 2 },
          { productId: wine.json().id, qty: 1 },
        ],
      },
    })
    orderId = order.json().id
    itemIds = order.json().items.map((i: { id: number }) => i.id)
  })

  after(() => {
    void app.close()
    close()
  })

  it('shows today’s active orders with items to kitchen, maître and admin', async () => {
    for (const cookie of [chefCookie, maitreCookie, adminCookie]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/kitchen/orders',
        headers: { cookie },
      })
      assert.equal(res.statusCode, 200)
      const order = res.json().orders.find((o: { id: number }) => o.id === orderId)
      assert.ok(order, 'the order must be on the display')
      assert.equal(order.items.length, 2)
      assert.ok(order.items.every((i: { doneAt: number | null }) => i.doneAt === null))
    }
  })

  it('keeps operators off the kitchen display', async () => {
    for (const [method, url] of [
      ['GET', '/api/kitchen/orders'],
      ['PUT', '/api/kitchen/items/1'],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: waiterCookie },
        ...(method === 'PUT' ? { payload: { done: true } } : {}),
      })
      assert.equal(res.statusCode, 403, `operator must not ${method} ${url}`)
    }
  })

  it('marks items done one by one; the order completes with the last one', async () => {
    const first = await app.inject({
      method: 'PUT',
      url: `/api/kitchen/items/${itemIds[0]}`,
      headers: { cookie: chefCookie },
      payload: { done: true },
    })
    assert.equal(first.statusCode, 200)
    assert.ok(first.json().doneAt)
    assert.equal(first.json().orderCompleted, false)

    const last = await app.inject({
      method: 'PUT',
      url: `/api/kitchen/items/${itemIds[1]}`,
      headers: { cookie: chefCookie },
      payload: { done: true },
    })
    assert.equal(last.json().orderCompleted, true)

    const display = await app.inject({
      method: 'GET',
      url: '/api/kitchen/orders',
      headers: { cookie: chefCookie },
    })
    const order = display.json().orders.find((o: { id: number }) => o.id === orderId)
    assert.ok(order.completedAt, 'order must be completed on the display')

    // The waiters' order list shows the ready state too.
    const list = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: adminCookie },
    })
    assert.ok(list.json().orders.find((o: { id: number }) => o.id === orderId).completedAt)
  })

  it('reopening an item un-completes the order', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/kitchen/items/${itemIds[1]}`,
      headers: { cookie: chefCookie },
      payload: { done: false },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().doneAt, null)
    assert.equal(res.json().orderCompleted, false)

    const display = await app.inject({
      method: 'GET',
      url: '/api/kitchen/orders',
      headers: { cookie: chefCookie },
    })
    const order = display.json().orders.find((o: { id: number }) => o.id === orderId)
    assert.equal(order.completedAt, null)
  })

  it('rejects a non-boolean done and an unknown item', async () => {
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/kitchen/items/${itemIds[0]}`,
      headers: { cookie: chefCookie },
      payload: { done: 'yes' },
    })
    assert.equal(bad.statusCode, 400)
    const missing = await app.inject({
      method: 'PUT',
      url: '/api/kitchen/items/99999',
      headers: { cookie: chefCookie },
      payload: { done: true },
    })
    assert.equal(missing.statusCode, 404)
  })

  it('locks a kitchen account out of everything else', async () => {
    for (const [method, url, payload] of [
      ['GET', '/api/orders', undefined],
      ['POST', '/api/orders', { customerName: 'X', items: [{ productId: 1, qty: 1 }] }],
      ['GET', '/api/menu', undefined],
      ['GET', '/api/products', undefined],
      ['GET', '/api/reports/daily', undefined],
      ['GET', '/api/users', undefined],
      ['GET', '/api/settings', undefined],
      ['PUT', '/api/settings', { restaurantName: 'X' }],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: chefCookie },
        ...(payload ? { payload } : {}),
      })
      assert.equal(res.statusCode, 403, `kitchen must not ${method} ${url}`)
    }
  })

  it('still lets a kitchen account change its own password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: chefCookie },
      payload: { currentPassword: 'password123', newPassword: 'freshpass456' },
    })
    assert.equal(res.statusCode, 200)
  })

  it('forbids a maître from creating or managing kitchen accounts', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: maitreCookie },
      payload: { username: 'chef2', password: 'password123', role: 'kitchen' },
    })
    assert.equal(create.statusCode, 403)

    const chefId = (
      (await app
        .inject({ method: 'GET', url: '/api/users', headers: { cookie: maitreCookie } })
        .then((r) => r.json())) as { id: number; username: string }[]
    ).find((u) => u.username === 'chef')!.id
    for (const payload of [{ password: 'hijacked123' }, { active: false }]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${chefId}`,
        headers: { cookie: maitreCookie },
        payload,
      })
      assert.equal(res.statusCode, 403, `${JSON.stringify(payload)} must be forbidden`)
    }
  })
})

describe('kitchen feature gate', () => {
  let app: FastifyInstance
  let close: () => void
  let adminCookie: string

  before(async () => {
    const t = await makeTestApp()
    app = t.app
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    adminCookie = await login(app, 'admin')
  })

  after(() => {
    void app.close()
    close()
  })

  it('is off until the first active kitchen account exists', async () => {
    const flags = await app.inject({
      method: 'GET',
      url: '/api/features',
      headers: { cookie: adminCookie },
    })
    assert.equal(flags.json().kitchenEnabled, false)

    const display = await app.inject({
      method: 'GET',
      url: '/api/kitchen/orders',
      headers: { cookie: adminCookie },
    })
    assert.equal(display.statusCode, 404)
    assert.equal(display.json().error, 'kitchen_disabled')
  })

  it('turns on with the first kitchen account and off when it is disabled', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { username: 'chef', password: 'password123', role: 'kitchen' },
    })
    assert.equal(created.statusCode, 201)
    const chefId = created.json().id

    const on = await app.inject({
      method: 'GET',
      url: '/api/features',
      headers: { cookie: adminCookie },
    })
    assert.equal(on.json().kitchenEnabled, true)
    const display = await app.inject({
      method: 'GET',
      url: '/api/kitchen/orders',
      headers: { cookie: adminCookie },
    })
    assert.equal(display.statusCode, 200)

    await app.inject({
      method: 'PATCH',
      url: `/api/users/${chefId}`,
      headers: { cookie: adminCookie },
      payload: { active: false },
    })
    const off = await app.inject({
      method: 'GET',
      url: '/api/features',
      headers: { cookie: adminCookie },
    })
    assert.equal(off.json().kitchenEnabled, false)
    const gone = await app.inject({
      method: 'GET',
      url: '/api/kitchen/orders',
      headers: { cookie: adminCookie },
    })
    assert.equal(gone.statusCode, 404)
  })
})
