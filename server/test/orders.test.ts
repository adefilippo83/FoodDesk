import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { login, makeTestApp, makeUser } from './helpers.js'

describe('menu ACL', () => {
  let app: FastifyInstance
  let close: () => void
  let adminCookie: string
  let opCookie: string

  before(async () => {
    const t = await makeTestApp()
    app = t.app
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    await makeUser(t.db, 'waiter', 'operator')
    adminCookie = await login(app, 'admin')
    opCookie = await login(app, 'waiter')
  })
  after(() => {
    void app.close()
    close()
  })

  it('lets an operator read the menu', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/menu', headers: { cookie: opCookie } })
    assert.equal(res.statusCode, 200)
  })

  it('forbids an operator creating a category', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { cookie: opCookie },
      payload: { name: 'Drinks' },
    })
    assert.equal(res.statusCode, 403)
  })

  it('forbids an operator changing a price', async () => {
    const cat = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { cookie: adminCookie },
      payload: { name: 'Drinks' },
    })
    const prod = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { cookie: adminCookie },
      payload: { name: 'Beer', priceCents: 500, categoryId: cat.json().id },
    })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/products/${prod.json().id}`,
      headers: { cookie: opCookie },
      payload: { priceCents: 1 },
    })
    assert.equal(res.statusCode, 403)
  })

  it('forbids an operator deleting a product', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/products/1',
      headers: { cookie: opCookie },
    })
    assert.equal(res.statusCode, 403)
  })

  it('hides a deactivated category and its products from the menu', async () => {
    const cat = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { cookie: adminCookie },
      payload: { name: 'Desserts' },
    })
    await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { cookie: adminCookie },
      payload: { name: 'Tiramisu', priceCents: 600, categoryId: cat.json().id },
    })
    await app.inject({
      method: 'DELETE',
      url: `/api/categories/${cat.json().id}`,
      headers: { cookie: adminCookie },
    })

    const menu = await app.inject({ method: 'GET', url: '/api/menu', headers: { cookie: opCookie } })
    const names = menu.json().flatMap((c: { products: { name: string }[] }) => c.products.map((p) => p.name))
    assert.ok(!names.includes('Tiramisu'), 'product of a deleted category still on the menu')
  })
})

describe('orders', () => {
  let app: FastifyInstance
  let close: () => void
  let adminCookie: string
  let opCookie: string
  let op2Cookie: string
  let beerId: number
  let wineId: number

  before(async () => {
    const t = await makeTestApp()
    app = t.app
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    await makeUser(t.db, 'marco', 'operator')
    await makeUser(t.db, 'lucia', 'operator')
    adminCookie = await login(app, 'admin')
    opCookie = await login(app, 'marco')
    op2Cookie = await login(app, 'lucia')

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
    beerId = beer.json().id
    wineId = wine.json().id
  })
  after(() => {
    void app.close()
    close()
  })

  it('prices the order from the database, ignoring anything the client sends', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: {
        tableLabel: '7',
        items: [
          // A tampered client tries to pay 1 cent for two beers.
          { productId: beerId, qty: 2, priceCents: 1 },
          { productId: wineId, qty: 1 },
        ],
      },
    })
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().totalCents, 500 * 2 + 750)
  })

  it('assigns increasing per-day ticket numbers', async () => {
    const a = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: { items: [{ productId: beerId, qty: 1 }] },
    })
    const b = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: op2Cookie },
      payload: { items: [{ productId: beerId, qty: 1 }] },
    })
    assert.equal(b.json().dailyNumber, a.json().dailyNumber + 1)
  })

  it('snapshots the price so later menu edits do not rewrite history', async () => {
    const order = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: { items: [{ productId: wineId, qty: 1 }] },
    })
    const id = order.json().id

    await app.inject({
      method: 'PATCH',
      url: `/api/products/${wineId}`,
      headers: { cookie: adminCookie },
      payload: { priceCents: 9999 },
    })

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/orders/${id}`,
      headers: { cookie: opCookie },
    })
    assert.equal(fetched.json().totalCents, 750)
    assert.equal(fetched.json().items[0].priceCentsSnapshot, 750)
  })

  it('rejects an order containing an unavailable product', async () => {
    const cat = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { cookie: adminCookie },
      payload: { name: 'Specials' },
    })
    const special = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { cookie: adminCookie },
      payload: { name: 'Sold out soup', priceCents: 400, categoryId: cat.json().id },
    })
    await app.inject({
      method: 'PATCH',
      url: `/api/products/${special.json().id}`,
      headers: { cookie: adminCookie },
      payload: { active: false },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: { items: [{ productId: special.json().id, qty: 1 }] },
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error, 'products_unavailable')
  })

  it('rejects junk quantities', async () => {
    for (const qty of [0, -1, 1.5, 1000]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: { cookie: opCookie },
        payload: { items: [{ productId: beerId, qty }] },
      })
      assert.equal(res.statusCode, 400, `qty ${qty} should be rejected`)
    }
  })

  it("stops an operator reading a colleague's order", async () => {
    const mine = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: { items: [{ productId: beerId, qty: 1 }] },
    })
    const id = mine.json().id

    const theirs = await app.inject({
      method: 'GET',
      url: `/api/orders/${id}`,
      headers: { cookie: op2Cookie },
    })
    assert.equal(theirs.statusCode, 403)

    const admin = await app.inject({
      method: 'GET',
      url: `/api/orders/${id}`,
      headers: { cookie: adminCookie },
    })
    assert.equal(admin.statusCode, 200)
  })

  it('lists only their own orders to an operator, all of them to an admin', async () => {
    const opList = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: opCookie },
    })
    const adminList = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: adminCookie },
    })
    const opNames: string[] = opList.json().orders.map((o: { createdByName: string }) => o.createdByName)
    assert.ok(opNames.every((n) => n === 'marco'), 'operator saw another waiter\'s order')
    assert.ok(adminList.json().orders.length > opList.json().orders.length)
  })
})
