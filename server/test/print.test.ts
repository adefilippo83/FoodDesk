import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
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

  for (const kind of ['receipt', 'kitchen'] as const) {
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
