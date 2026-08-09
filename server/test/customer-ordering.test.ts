import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { login, makeTestApp, makeUser } from './helpers.js'

describe('customer self-ordering (phase A)', () => {
  let app: FastifyInstance
  let close: () => void
  let adminCookie: string
  let opCookie: string
  let kitchenCookie: string
  let beerId: number
  let cakeId: number

  // Distinct client IPs per scenario so per-IP rate limits never interfere
  // across tests; the rate limit itself has a dedicated test.
  let ipSeq = 0
  const nextIp = () => `10.42.0.${++ipSeq + 9}`

  const createOrder = (payload: Record<string, unknown>, ip = nextIp()) =>
    app.inject({
      method: 'POST',
      url: '/api/public/orders',
      remoteAddress: ip,
      payload,
    })

  before(async () => {
    delete process.env.KITCHEN_PRINTER
    delete process.env.CUSTOMER_ORDER_CAP
    const t = await makeTestApp()
    app = t.app
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    await makeUser(t.db, 'marco', 'operator')
    await makeUser(t.db, 'cucina', 'kitchen')
    adminCookie = await login(app, 'admin')
    opCookie = await login(app, 'marco')
    kitchenCookie = await login(app, 'cucina')

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
    const cake = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { cookie: adminCookie },
      payload: { name: 'Cake', priceCents: 300, categoryId: cat.json().id },
    })
    cakeId = cake.json().id
    // Coperto: €2.50 a head — customer orders must charge it per person.
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { coverChargeCents: 250 },
    })
  })

  after(() => {
    delete process.env.CUSTOMER_ORDER_CAP
    void app.close()
    close()
  })

  it('does not exist until the admin switches it on', async () => {
    const menu = await app.inject({ method: 'GET', url: '/api/public/menu' })
    assert.equal(menu.statusCode, 404)
    const order = await createOrder({
      customerName: 'X',
      covers: 1,
      items: [{ productId: beerId, qty: 1 }],
    })
    assert.equal(order.statusCode, 404)

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { customerOrdering: true },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().customerOrdering, true)
  })

  it('serves the public menu without prices leaking anything else', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/public/menu' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.coverChargeCents, 250)
    assert.equal(body.menu.length, 1)
    assert.deepEqual(
      body.menu[0].products.map((p: { name: string }) => p.name).sort(),
      ['Beer', 'Cake'],
    )
  })

  it('rejects a nameless order and zero people', async () => {
    const noName = await createOrder({ covers: 2, items: [{ productId: beerId, qty: 1 }] })
    assert.equal(noName.statusCode, 400)
    assert.equal(noName.json().error, 'customer_name_required')

    const zero = await createOrder({
      customerName: 'Anna',
      covers: 0,
      items: [{ productId: beerId, qty: 1 }],
    })
    assert.equal(zero.statusCode, 400)
    assert.equal(zero.json().error, 'invalid_covers')
  })

  it('prices from the database, coperto per person, token instead of id', async () => {
    const res = await createOrder({
      customerName: 'Anna',
      covers: 3,
      items: [{ productId: beerId, qty: 2, priceCents: 1 }], // tampered price ignored
    })
    assert.equal(res.statusCode, 201)
    const body = res.json()
    assert.equal(body.totalCents, 2 * 500 + 3 * 250)
    assert.ok(body.publicToken.length >= 20)
    assert.ok(body.dailyNumber >= 1)
    assert.equal(body.id, undefined)
  })

  it('replays an identical retry instead of duplicating', async () => {
    const ip = nextIp()
    const payload = {
      customerName: 'Bruno',
      covers: 1,
      clientKey: 'cust-retry-1',
      items: [{ productId: beerId, qty: 1 }],
    }
    const first = await createOrder(payload, ip)
    assert.equal(first.statusCode, 201)
    const second = await createOrder(payload, ip)
    assert.equal(second.statusCode, 200)
    assert.equal(second.json().dailyNumber, first.json().dailyNumber)
    assert.equal(second.json().publicToken, first.json().publicToken)
  })

  it('follows the order by token through preparation, ready and paid', async () => {
    const created = await createOrder({
      customerName: 'Carla',
      covers: 2,
      items: [{ productId: cakeId, qty: 1 }],
    })
    assert.equal(created.statusCode, 201)
    const token = created.json().publicToken

    let status = await app.inject({ method: 'GET', url: `/api/public/orders/${token}` })
    assert.equal(status.statusCode, 200)
    assert.equal(status.json().completedAt, null)
    assert.equal(status.json().paidAt, null)
    assert.equal(status.json().items.length, 1)

    // Not paid yet → the kitchen must NOT see it: the register releases it.
    let kds = await app.inject({
      method: 'GET',
      url: '/api/kitchen/orders',
      headers: { cookie: kitchenCookie },
    })
    assert.ok(
      !kds
        .json()
        .orders.some(
          (o: { dailyNumber: number }) => o.dailyNumber === created.json().dailyNumber,
        ),
      'unpaid counter order must be invisible to the kitchen',
    )

    // Any floor staff (not the creator — there is none) sees it and marks it
    // paid at the counter — which is what sends it to the kitchen.
    const listed = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: opCookie },
    })
    const mine = listed
      .json()
      .orders.find((o: { dailyNumber: number }) => o.dailyNumber === created.json().dailyNumber)
    assert.ok(mine, 'operator cannot see the customer order')
    assert.equal(mine.origin, 'customer')
    assert.equal(mine.createdByName, null)

    const paid = await app.inject({
      method: 'POST',
      url: `/api/orders/${mine.id}/paid`,
      headers: { cookie: opCookie },
    })
    assert.equal(paid.statusCode, 200)
    assert.equal(paid.json().paymentMethod, 'cash')

    status = await app.inject({ method: 'GET', url: `/api/public/orders/${token}` })
    assert.ok(status.json().paidAt !== null)

    // Paid → on the kitchen display; the cook works it, the phone sees it.
    kds = await app.inject({
      method: 'GET',
      url: '/api/kitchen/orders',
      headers: { cookie: kitchenCookie },
    })
    const kdsOrder = kds
      .json()
      .orders.find((o: { dailyNumber: number }) => o.dailyNumber === created.json().dailyNumber)
    assert.ok(kdsOrder, 'paid customer order missing on the kitchen display')
    assert.equal(kdsOrder.createdByName, null)
    await app.inject({
      method: 'PUT',
      url: `/api/kitchen/items/${kdsOrder.items[0].id}`,
      headers: { cookie: kitchenCookie },
      payload: { done: true },
    })
    status = await app.inject({ method: 'GET', url: `/api/public/orders/${token}` })
    assert.ok(status.json().items[0].doneAt !== null)
    assert.ok(status.json().completedAt !== null)

    // Idempotent second tap.
    const again = await app.inject({
      method: 'POST',
      url: `/api/orders/${mine.id}/paid`,
      headers: { cookie: opCookie },
    })
    assert.equal(again.statusCode, 200)
  })

  it('rejects junk tokens without touching the database', async () => {
    for (const tok of ['1', 'short', '../../etc/passwd', 'x'.repeat(100)]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/public/orders/${encodeURIComponent(tok)}`,
      })
      assert.equal(res.statusCode, 404)
    }
  })

  it('kitchen accounts can neither create orders nor mark them paid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders/1/paid',
      headers: { cookie: kitchenCookie },
    })
    assert.equal(res.statusCode, 403)
  })

  it('stops taking orders at the configured cap', async () => {
    process.env.CUSTOMER_ORDER_CAP = '2'
    try {
      // Open customer orders so far: several from earlier tests are unpaid —
      // the cap counts open ones, so 2 is already exceeded.
      const res = await createOrder({
        customerName: 'Dario',
        covers: 1,
        items: [{ productId: beerId, qty: 1 }],
      })
      assert.equal(res.statusCode, 503)
      assert.equal(res.json().error, 'venue_busy')
    } finally {
      delete process.env.CUSTOMER_ORDER_CAP
    }
  })

  it('rate-limits a single client hammering order creation', async () => {
    const ip = nextIp()
    let limited = false
    for (let i = 0; i < 7; i++) {
      const res = await createOrder(
        { customerName: `Spam${i}`, covers: 1, items: [{ productId: beerId, qty: 1 }] },
        ip,
      )
      if (res.statusCode === 429) {
        limited = true
        break
      }
    }
    assert.ok(limited, 'never hit the per-IP rate limit')
  })

  it('exposes the stock counter on the public menu so phones can cap adds', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/products/${beerId}`,
      headers: { cookie: adminCookie },
      payload: { stockRemaining: 7 },
    })
    const res = await app.inject({ method: 'GET', url: '/api/public/menu' })
    assert.equal(res.statusCode, 200)
    const beer = res
      .json()
      .menu.flatMap((c: { products: { id: number; stockRemaining: number | null }[] }) => c.products)
      .find((p: { id: number }) => p.id === beerId)
    assert.equal(beer.stockRemaining, 7)
    // Back to untracked so later tests keep their assumptions.
    await app.inject({
      method: 'PATCH',
      url: `/api/products/${beerId}`,
      headers: { cookie: adminCookie },
      payload: { stockRemaining: null },
    })
  })

  it('rejects the status event stream for junk or unknown tokens', async () => {
    const junk = await app.inject({ method: 'GET', url: '/api/public/orders/short/events' })
    assert.equal(junk.statusCode, 404)
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/public/orders/AAAAAAAAAAAAAAAAAAAAAAAA/events',
    })
    assert.equal(unknown.statusCode, 404)
  })

  it('streams an orders ping to the status page when anything changes', async () => {
    const created = await createOrder({
      customerName: 'Streamer',
      covers: 1,
      items: [{ productId: beerId, qty: 1 }],
    })
    assert.equal(created.statusCode, 201)
    const token = created.json().publicToken

    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port
    const controller = new AbortController()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/public/orders/${token}/events`, {
        signal: controller.signal,
      })
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const trigger = createOrder({
        customerName: 'Second',
        covers: 1,
        items: [{ productId: beerId, qty: 1 }],
      })
      while (!buffer.includes('event: orders')) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value)
      }
      await trigger
      assert.ok(buffer.includes('event: orders'), `no orders event in: ${buffer}`)
    } finally {
      controller.abort()
    }
  })
})
