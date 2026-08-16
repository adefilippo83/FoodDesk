import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { ordersBus } from '../src/lib/events.js'
import { login, makeTestApp, makeUser } from './helpers.js'

describe('order events (SSE) and idempotency', () => {
  let app: FastifyInstance
  let close: () => void
  let adminCookie: string
  let opCookie: string
  let chefCookie: string
  let beerId: number

  before(async () => {
    const t = await makeTestApp()
    app = t.app
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    await makeUser(t.db, 'marco', 'operator')
    await makeUser(t.db, 'chef', 'kitchen')
    adminCookie = await login(app, 'admin')
    opCookie = await login(app, 'marco')
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
    beerId = beer.json().id
  })

  after(() => {
    void app.close()
    close()
  })

  it('requires auth on /api/events', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events' })
    assert.equal(res.statusCode, 401)
  })

  it('pings the bus on create, kitchen toggle and cancel', async () => {
    let count = 0
    const onOrders = () => count++
    ordersBus.on('orders', onOrders)
    try {
      let seen = count
      const order = await app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: { cookie: opCookie },
        payload: { customerName: 'Ping', items: [{ productId: beerId, qty: 1 }] },
      })
      assert.equal(order.statusCode, 201)
      assert.ok(count > seen, 'creating an order must ping')

      const itemId = order.json().items[0].id
      seen = count
      await app.inject({
        method: 'PUT',
        url: `/api/kitchen/items/${itemId}`,
        headers: { cookie: chefCookie },
        payload: { done: true },
      })
      assert.ok(count > seen, 'a kitchen toggle must ping')

      seen = count
      await app.inject({
        method: 'POST',
        url: `/api/orders/${order.json().id}/cancel`,
        headers: { cookie: adminCookie },
      })
      assert.ok(count > seen, 'cancelling must ping')
    } finally {
      ordersBus.off('orders', onOrders)
    }
  })

  it('streams an orders event to a connected client', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port
    const controller = new AbortController()

    const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
      headers: { cookie: adminCookie },
      signal: controller.signal,
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const trigger = app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: { customerName: 'Streamed', items: [{ productId: beerId, qty: 1 }] },
    })

    const deadline = Date.now() + 5000
    while (!buffer.includes('event: orders') && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), 250)),
      ])
      if (chunk && !chunk.done && chunk.value) buffer += decoder.decode(chunk.value)
    }
    controller.abort()
    await trigger

    assert.ok(buffer.includes('retry: 3000'), 'stream must open with a retry hint')
    assert.ok(buffer.includes('event: orders'), `no orders event received: ${buffer}`)
  })

  it('replays the same clientKey instead of creating a duplicate order', async () => {
    const payload = {
      customerName: 'Retry me',
      clientKey: 'test-key-001',
      items: [{ productId: beerId, qty: 2 }],
    }
    const first = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload,
    })
    assert.equal(first.statusCode, 201)

    const second = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload,
    })
    assert.equal(second.statusCode, 200, 'a replay answers 200, not 201')
    assert.equal(second.json().id, first.json().id)
    assert.equal(second.json().dailyNumber, first.json().dailyNumber)
    assert.equal(second.json().items.length, 1)

    const list = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: adminCookie },
    })
    const copies = list
      .json()
      .orders.filter((o: { customerName: string | null }) => o.customerName === 'Retry me')
    assert.equal(copies.length, 1, 'the retry must not create a twin order')
  })

  it('rejects a reused clientKey whose payload changed, instead of silently replaying', async () => {
    const base = { customerName: 'Edited', clientKey: 'edit-key-1' }
    const first = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: { ...base, items: [{ productId: beerId, qty: 1 }] },
    })
    assert.equal(first.statusCode, 201)

    // Same key, an extra portion: a naive replay would return the 1-item order
    // and lose the change. It must 409 so the client knows to use a fresh key.
    const edited = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: { ...base, items: [{ productId: beerId, qty: 2 }] },
    })
    assert.equal(edited.statusCode, 409)
    assert.equal(edited.json().error, 'payload_mismatch')

    // The identical resubmission still replays cleanly (200, same order).
    const same = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: { ...base, items: [{ productId: beerId, qty: 1 }] },
    })
    assert.equal(same.statusCode, 200)
    assert.equal(same.json().id, first.json().id)
  })

  it('treats distinct keys (and missing keys) as distinct orders', async () => {
    for (const clientKey of ['test-key-002', 'test-key-003', undefined]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: { cookie: opCookie },
        payload: { customerName: 'Distinct', clientKey, items: [{ productId: beerId, qty: 1 }] },
      })
      assert.equal(res.statusCode, 201)
    }
    const list = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: adminCookie },
    })
    const copies = list
      .json()
      .orders.filter((o: { customerName: string | null }) => o.customerName === 'Distinct')
    assert.equal(copies.length, 3)
  })
})
