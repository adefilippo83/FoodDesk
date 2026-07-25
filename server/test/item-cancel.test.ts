import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { login, makeTestApp, makeUser } from './helpers.js'

/**
 * Line-level cancellation: admin/maître anywhere, a waiter on their own
 * orders. Totals are recomputed, documents and reports skip the line, the
 * kitchen sees it struck out, and cancelling the last active line cancels
 * the whole order.
 */
describe('order item cancellation', () => {
  let app: FastifyInstance
  let close: () => void
  let adminCookie: string
  let maitreCookie: string
  let marcoCookie: string
  let luciaCookie: string
  let chefCookie: string
  let beerId: number
  let wineId: number

  async function createOrder(cookie: string, customer: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie },
      payload: {
        customerName: customer,
        items: [
          { productId: beerId, qty: 2 },
          { productId: wineId, qty: 1 },
        ],
      },
    })
    assert.equal(res.statusCode, 201)
    return res.json()
  }

  const itemFor = (order: { items: { id: number; productId: number }[] }, productId: number) =>
    order.items.find((i) => i.productId === productId)!.id

  before(async () => {
    const t = await makeTestApp()
    app = t.app
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    await makeUser(t.db, 'giulia', 'maitre')
    await makeUser(t.db, 'marco', 'operator')
    await makeUser(t.db, 'lucia', 'operator')
    await makeUser(t.db, 'chef', 'kitchen')
    adminCookie = await login(app, 'admin')
    maitreCookie = await login(app, 'giulia')
    marcoCookie = await login(app, 'marco')
    luciaCookie = await login(app, 'lucia')
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
    beerId = beer.json().id
    wineId = wine.json().id
  })

  after(() => {
    void app.close()
    close()
  })

  it('lets a waiter cancel a line on their own order, recomputing the total', async () => {
    const order = await createOrder(marcoCookie, 'Marco 1')
    assert.equal(order.totalCents, 1750)

    const res = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/items/${itemFor(order, beerId)}/cancel`,
      headers: { cookie: marcoCookie },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().totalCents, 750, '2×Beer removed from the total')
    const beerLine = res.json().items.find((i: { productId: number }) => i.productId === beerId)
    assert.ok(beerLine.cancelledAt, 'the line is soft-cancelled, not deleted')
    assert.equal(res.json().cancelledAt, null, 'the order itself stays alive')

    // Idempotent: cancelling again changes nothing.
    const again = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/items/${itemFor(order, beerId)}/cancel`,
      headers: { cookie: marcoCookie },
    })
    assert.equal(again.statusCode, 200)
    assert.equal(again.json().totalCents, 750)

    // Cancelling the last active line cancels the whole order.
    const last = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/items/${itemFor(order, wineId)}/cancel`,
      headers: { cookie: marcoCookie },
    })
    assert.equal(last.statusCode, 200)
    assert.ok(last.json().cancelledAt, 'no active lines left → order cancelled')

    const detail = await app.inject({
      method: 'GET',
      url: `/api/orders/${order.id}`,
      headers: { cookie: adminCookie },
    })
    assert.equal(detail.json().cancelledByName, 'marco')

    // A cancelled order refuses further line edits.
    const late = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/items/${itemFor(order, beerId)}/cancel`,
      headers: { cookie: marcoCookie },
    })
    assert.equal(late.statusCode, 409)
  })

  it("blocks a waiter on a colleague's order; the maître may", async () => {
    const order = await createOrder(luciaCookie, 'Lucia 1')

    const denied = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/items/${itemFor(order, beerId)}/cancel`,
      headers: { cookie: marcoCookie },
    })
    assert.equal(denied.statusCode, 403)

    const allowed = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/items/${itemFor(order, beerId)}/cancel`,
      headers: { cookie: maitreCookie },
    })
    assert.equal(allowed.statusCode, 200)
    assert.equal(allowed.json().totalCents, 750)
  })

  it('keeps kitchen accounts out entirely', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders/1/items/1/cancel',
      headers: { cookie: chefCookie },
    })
    assert.equal(res.statusCode, 403)
  })

  it('shows the cancelled line struck out in the kitchen and completes on active lines only', async () => {
    const order = await createOrder(marcoCookie, 'Marco 2')
    await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/items/${itemFor(order, beerId)}/cancel`,
      headers: { cookie: maitreCookie },
    })

    const display = await app.inject({
      method: 'GET',
      url: '/api/kitchen/orders',
      headers: { cookie: chefCookie },
    })
    const card = display.json().orders.find((o: { id: number }) => o.id === order.id)
    const beerLine = card.items.find((i: { id: number }) => i.id === itemFor(order, beerId))
    assert.ok(beerLine.cancelledAt, 'the display must carry the cancelled state')

    // The cancelled line cannot be toggled...
    const toggle = await app.inject({
      method: 'PUT',
      url: `/api/kitchen/items/${itemFor(order, beerId)}`,
      headers: { cookie: chefCookie },
      payload: { done: true },
    })
    assert.equal(toggle.statusCode, 409)

    // ...and completing the remaining active line completes the order.
    const doneRes = await app.inject({
      method: 'PUT',
      url: `/api/kitchen/items/${itemFor(order, wineId)}`,
      headers: { cookie: chefCookie },
      payload: { done: true },
    })
    assert.equal(doneRes.json().orderCompleted, true)
  })

  it('excludes cancelled lines from the report and flags them in the CSV', async () => {
    // At this point: Marco 1 fully cancelled; Lucia 1 = wine only (750);
    // Marco 2 = wine only (750). Beer never earned a cent.
    const report = await app.inject({
      method: 'GET',
      url: '/api/reports/daily',
      headers: { cookie: adminCookie },
    })
    assert.equal(report.json().cancelledCount, 1)
    assert.equal(report.json().revenueCents, 1500)
    assert.equal(
      report.json().byProduct.find((p: { name: string }) => p.name.startsWith('Beer')),
      undefined,
      'cancelled lines must not appear in the product tally',
    )

    const csv = await app.inject({
      method: 'GET',
      url: '/api/reports/daily.csv',
      headers: { cookie: adminCookie },
    })
    const beerLines = csv.body.split('\r\n').filter((l: string) => l.includes(';Beer;'))
    assert.ok(beerLines.length >= 2)
    assert.ok(
      beerLines.every((l: string) => l.endsWith(';yes')),
      `every cancelled beer line must be flagged: ${beerLines.join(' | ')}`,
    )
  })
})
