import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../src/db/index.js'
import { orders, products } from '../src/db/schema.js'
import { sweepStaleCounterOrders } from '../src/payments/lifecycle.js'
import { login, makeTestApp, makeUser } from './helpers.js'

/**
 * Unpaid customer counter orders reserve stock but have no provider to expire
 * them; the TTL sweep reclaims the stock of ones the customer never came to
 * pay for, and must never race a cashier into a both-cancelled-and-paid state.
 */
describe('counter order TTL expiry', () => {
  let app: FastifyInstance
  let db: Db
  let close: () => void
  let adminCookie: string
  let beerId: number
  let ip = 0

  const stockOf = async () =>
    (await db.select().from(products).where(eq(products.id, beerId)))[0]!.stockRemaining

  const placeCounterOrder = async (name: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      remoteAddress: `10.9.0.${++ip}`,
      payload: { customerName: name, covers: 1, payment: 'counter', items: [{ productId: beerId, qty: 1 }] },
    })
    assert.equal(res.statusCode, 201)
    const token = res.json().publicToken
    return (await db.select().from(orders).where(eq(orders.publicToken, token)).limit(1))[0]!
  }

  const backdate = async (id: number, secondsAgo: number) => {
    await db
      .update(orders)
      .set({ createdAt: Math.floor(Date.now() / 1000) - secondsAgo })
      .where(eq(orders.id, id))
  }

  before(async () => {
    delete process.env.COUNTER_ORDER_TTL_MIN // default 30 min
    const t = await makeTestApp()
    app = t.app
    db = t.db
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    adminCookie = await login(app, 'admin')

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
    beerId = beer.json().id
    await app.inject({
      method: 'PATCH',
      url: `/api/products/${beerId}`,
      headers: { cookie: adminCookie },
      payload: { stockRemaining: 10 },
    })
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { customerOrdering: true },
    })
  })

  after(() => {
    void app.close()
    close()
  })

  it('leaves a fresh unpaid counter order alone', async () => {
    const before = await stockOf()
    const order = await placeCounterOrder('Fresh Franca')
    assert.equal(await stockOf(), before! - 1)
    await sweepStaleCounterOrders(db)
    const row = (await db.select().from(orders).where(eq(orders.id, order.id)).limit(1))[0]!
    assert.equal(row.cancelledAt, null, 'a recent order must not be swept')
    assert.equal(await stockOf(), before! - 1, 'stock stays reserved')
  })

  it('expires a stale unpaid counter order and gives the stock back', async () => {
    const before = await stockOf()
    const order = await placeCounterOrder('Stale Stefano')
    assert.equal(await stockOf(), before! - 1)
    await backdate(order.id, 31 * 60) // older than the 30-min default
    await sweepStaleCounterOrders(db)
    const row = (await db.select().from(orders).where(eq(orders.id, order.id)).limit(1))[0]!
    assert.ok(row.cancelledAt !== null, 'the stale order is cancelled')
    assert.equal(await stockOf(), before!, 'reserved stock is returned')
  })

  it('a cashier cannot pay an order the sweep already expired', async () => {
    const order = await placeCounterOrder('Racing Remo')
    await backdate(order.id, 31 * 60)
    await sweepStaleCounterOrders(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/paid`,
      headers: { cookie: adminCookie },
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error, 'order_cancelled')
  })

  it('does not touch a counter order that was paid in time', async () => {
    const order = await placeCounterOrder('Paid Paola')
    const paid = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/paid`,
      headers: { cookie: adminCookie },
    })
    assert.equal(paid.statusCode, 200)
    // Even if it later looks old, a paid order is out of the sweep's scope.
    await backdate(order.id, 60 * 60)
    await sweepStaleCounterOrders(db)
    const row = (await db.select().from(orders).where(eq(orders.id, order.id)).limit(1))[0]!
    assert.equal(row.cancelledAt, null)
    assert.ok(row.paidAt !== null)
  })
})
