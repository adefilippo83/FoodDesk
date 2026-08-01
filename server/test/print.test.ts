import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../src/db/index.js'
import { retryFailedPrints } from '../src/print/service.js'
import { login, makeTestApp, makeUser } from './helpers.js'

describe('printing', () => {
  let app: FastifyInstance
  let close: () => void
  let adminCookie: string
  let opCookie: string
  let op2Cookie: string
  let orderId: number

  before(async () => {
    delete process.env.KITCHEN_PRINTER

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
    const order = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: {
        customerName: '9',
        note: 'birthday table',
        items: [{ productId: beer.json().id, qty: 2, note: 'cold ones' }],
      },
    })
    orderId = order.json().id
  })

  after(() => {
    void app.close()
    close()
  })

  for (const kind of ['receipt', 'kitchen', 'order'] as const) {
    it(`serves a real PDF for the ${kind} document`, async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/orders/${orderId}/${kind}.pdf`,
        headers: { cookie: opCookie },
      })
      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['content-type'], 'application/pdf')
      assert.ok(res.rawPayload.subarray(0, 5).toString() === '%PDF-', 'missing PDF magic bytes')
      assert.ok(res.rawPayload.length > 500, 'suspiciously small PDF')
    })

    it(`blocks a colleague from the ${kind} PDF`, async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/orders/${orderId}/${kind}.pdf`,
        headers: { cookie: op2Cookie },
      })
      assert.equal(res.statusCode, 403)
    })

    it(`lets an admin fetch the ${kind} PDF`, async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/orders/${orderId}/${kind}.pdf`,
        headers: { cookie: adminCookie },
      })
      assert.equal(res.statusCode, 200)
    })
  }

  it('marks new orders printer_not_configured when there is no queue', async () => {
    // The order was created without KITCHEN_PRINTER; the background print runs
    // fire-and-forget, so poll briefly for it to record its outcome.
    let printError: string | null = null
    for (let i = 0; i < 20 && !printError; i++) {
      const order = await app.inject({
        method: 'GET',
        url: `/api/orders/${orderId}`,
        headers: { cookie: adminCookie },
      })
      printError = order.json().printError
      if (!printError) await new Promise((r) => setTimeout(r, 50))
    }
    assert.equal(printError, 'printer_not_configured')
  })

  it('reports 409 on reprint when no printer is configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/print`,
      headers: { cookie: opCookie },
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error, 'printer_not_configured')
  })

  it('records print_failed on the order when the CUPS queue rejects the job', async () => {
    process.env.KITCHEN_PRINTER = 'no-such-queue-fooddesk-test'
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/orders/${orderId}/print`,
        headers: { cookie: opCookie },
      })
      assert.equal(res.statusCode, 502)
      assert.equal(res.json().error, 'print_failed')

      const order = await app.inject({
        method: 'GET',
        url: `/api/orders/${orderId}`,
        headers: { cookie: opCookie },
      })
      assert.ok(order.json().printError, 'printError not recorded on the order')
      assert.ok(order.json().printAttempts >= 1)
      assert.equal(order.json().printedAt, null)
    } finally {
      delete process.env.KITCHEN_PRINTER
    }
  })

  it("blocks a colleague from reprinting someone else's order", async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/print`,
      headers: { cookie: op2Cookie },
    })
    assert.equal(res.statusCode, 403)
  })

})

describe('automatic print retry', () => {
  let app: FastifyInstance
  let close: () => void
  let db: Db
  let adminCookie: string
  let opCookie: string
  let beerId: number

  async function fetchAttempts(id: number): Promise<number> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/orders/${id}`,
      headers: { cookie: adminCookie },
    })
    return res.json().printAttempts
  }

  async function createFailedOrder(customer: string): Promise<number> {
    const order = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: { customerName: customer, items: [{ productId: beerId, qty: 1 }] },
    })
    const id = order.json().id
    // The background print is fire-and-forget: wait for its failure to land.
    // Generous budget — spawning `lp` on a loaded machine can lag.
    for (let i = 0; i < 100; i++) {
      if ((await fetchAttempts(id)) >= 1) return id
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('background print never recorded its attempt')
  }

  before(async () => {
    process.env.KITCHEN_PRINTER = 'no-such-queue-retry-test'
    const t = await makeTestApp()
    app = t.app
    close = t.close
    db = t.db
    await makeUser(t.db, 'admin', 'admin')
    await makeUser(t.db, 'marco', 'operator')
    adminCookie = await login(app, 'admin')
    opCookie = await login(app, 'marco')

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
    delete process.env.KITCHEN_PRINTER
    void app.close()
    close()
  })

  it('retries a failed print until the attempt cap, then gives up', async () => {
    const id = await createFailedOrder('Retry me')
    let attempts = await fetchAttempts(id)
    assert.ok(attempts >= 1)

    for (let i = 0; i < 10 && attempts < 5; i++) {
      await retryFailedPrints(db)
      const next = await fetchAttempts(id)
      assert.equal(next, attempts + 1, 'each sweep must retry exactly once')
      attempts = next
    }
    assert.equal(attempts, 5)

    // Cap reached: further sweeps must leave the order alone.
    await retryFailedPrints(db)
    assert.equal(await fetchAttempts(id), 5)
  })

  it('does not retry cancelled orders', async () => {
    const id = await createFailedOrder('Cancelled one')
    const before = await fetchAttempts(id)
    await app.inject({
      method: 'POST',
      url: `/api/orders/${id}/cancel`,
      headers: { cookie: adminCookie },
    })
    await retryFailedPrints(db)
    assert.equal(await fetchAttempts(id), before)
  })

  it('is a no-op when no printer is configured', async () => {
    const id = await createFailedOrder('No printer later')
    const before = await fetchAttempts(id)
    delete process.env.KITCHEN_PRINTER
    try {
      await retryFailedPrints(db)
      assert.equal(await fetchAttempts(id), before)
    } finally {
      process.env.KITCHEN_PRINTER = 'no-such-queue-retry-test'
    }
  })
})
