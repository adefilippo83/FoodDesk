import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { login, makeTestApp, makeUser } from './helpers.js'

describe('coperto, cancellation, settings, passwords, reorder', () => {
  let app: FastifyInstance
  let close: () => void
  let adminCookie: string
  let opCookie: string
  let beerId: number
  let catId: number

  before(async () => {
    const t = await makeTestApp()
    app = t.app
    close = t.close
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
    catId = cat.json().id
    const beer = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { cookie: adminCookie },
      payload: { name: 'Beer', priceCents: 500, categoryId: catId },
    })
    beerId = beer.json().id
  })

  after(() => {
    void app.close()
    close()
  })

  // ---- customer name ----

  it('rejects an order without a customer name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: { items: [{ productId: beerId, qty: 1 }] },
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error, 'customer_name_required')
  })

  // ---- settings + coperto ----

  it('forbids an operator from reading or writing settings', async () => {
    const read = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: opCookie },
    })
    assert.equal(read.statusCode, 403)
    const write = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: opCookie },
      payload: { coverChargeCents: 0 },
    })
    assert.equal(write.statusCode, 403)
  })

  it('lets an operator read /api/config', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config', headers: { cookie: opCookie } })
    assert.equal(res.statusCode, 200)
    assert.equal(typeof res.json().coverChargeCents, 'number')
    assert.equal(typeof res.json().printerConfigured, 'boolean')
  })

  it('charges the configured coperto per cover and snapshots it', async () => {
    const set = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { coverChargeCents: 150 },
    })
    assert.equal(set.statusCode, 200)

    const order = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: { customerName: 'Rossi', covers: 3, items: [{ productId: beerId, qty: 2 }] },
    })
    assert.equal(order.statusCode, 201)
    // 2 beers (1000) + 3 covers × 150 = 1450
    assert.equal(order.json().totalCents, 1450)
    assert.equal(order.json().covers, 3)
    assert.equal(order.json().coverChargeCents, 150)

    // Changing the setting later must not touch the stored order.
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { coverChargeCents: 999 },
    })
    const fetched = await app.inject({
      method: 'GET',
      url: `/api/orders/${order.json().id}`,
      headers: { cookie: opCookie },
    })
    assert.equal(fetched.json().totalCents, 1450)

    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { coverChargeCents: 150 },
    })
  })

  it('allows zero covers (bar order) and rejects junk', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: { customerName: 'Bar', covers: 0, items: [{ productId: beerId, qty: 1 }] },
    })
    assert.equal(ok.statusCode, 201)
    assert.equal(ok.json().totalCents, 500)

    for (const covers of [-1, 2.5, 1000]) {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: { cookie: opCookie },
        payload: { customerName: 'X', covers, items: [{ productId: beerId, qty: 1 }] },
      })
      assert.equal(bad.statusCode, 400, `covers ${covers} should be rejected`)
    }
  })

  it('rejects an oversized or malformed settings image', async () => {
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { logoImage: 'data:text/html;base64,PGh0bWw+' },
    })
    assert.equal(bad.statusCode, 400)
    const big = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { logoImage: `data:image/png;base64,${'A'.repeat(1_000_000)}` },
    })
    assert.equal(big.statusCode, 400)
  })

  // ---- order sheet settings ----

  it('saves and returns order-sheet settings, rejecting junk', async () => {
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: {
        orderHeaderText: 'Sagra di prova',
        orderFooterText: 'Arrivederci',
        orderDisclaimer: 'Documento non fiscale',
        orderCategoryStyle: 'separator',
        orderHeaderFontSize: 14,
        orderDisclaimerFontSize: 10,
        orderHeaderImageWidthPct: 50,
      },
    })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.json().orderCategoryStyle, 'separator')
    assert.equal(ok.json().orderDisclaimer, 'Documento non fiscale')
    assert.equal(ok.json().orderHeaderFontSize, 14)
    assert.equal(ok.json().orderDisclaimerFontSize, 10)
    assert.equal(ok.json().orderHeaderImageWidthPct, 50)

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { orderCategoryStyle: 'rainbow' },
    })
    assert.equal(bad.statusCode, 400)
    assert.equal(bad.json().error, 'invalid_category_style')

    for (const payload of [
      { orderHeaderFontSize: 100 },
      { orderHeaderFontSize: 9.5 },
      { orderHeaderImageWidthPct: 5 },
      { orderFooterImageWidthPct: '50' },
    ]) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { cookie: adminCookie },
        payload,
      })
      assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} should be rejected`)
      assert.equal(res.json().error, 'invalid_number')
    }
  })

  it('exposes the order-sheet layout fields to operators via /api/config', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config', headers: { cookie: opCookie } })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().orderCategoryStyle, 'separator')
    assert.equal(res.json().orderDisclaimer, 'Documento non fiscale')
  })

  it('serves the order-sheet PDF preview to admins only', async () => {
    const admin = await app.inject({
      method: 'GET',
      url: '/api/settings/preview.pdf?kind=order',
      headers: { cookie: adminCookie },
    })
    assert.equal(admin.statusCode, 200)
    assert.equal(admin.headers['content-type'], 'application/pdf')
    assert.ok(admin.rawPayload.subarray(0, 5).toString() === '%PDF-')

    const op = await app.inject({
      method: 'GET',
      url: '/api/settings/preview.pdf?kind=order',
      headers: { cookie: opCookie },
    })
    assert.equal(op.statusCode, 403)
  })

  // ---- cancellation ----

  it('lets an admin cancel an order; totals skip it but the row survives', async () => {
    const order = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: { customerName: 'Da annullare', items: [{ productId: beerId, qty: 4 }] },
    })
    const id = order.json().id

    const before = await app.inject({
      method: 'GET',
      url: '/api/reports/daily',
      headers: { cookie: adminCookie },
    })

    const denied = await app.inject({
      method: 'POST',
      url: `/api/orders/${id}/cancel`,
      headers: { cookie: opCookie },
    })
    assert.equal(denied.statusCode, 403, 'operator must not cancel')

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/orders/${id}/cancel`,
      headers: { cookie: adminCookie },
    })
    assert.equal(cancelled.statusCode, 200)
    assert.ok(cancelled.json().cancelledAt)

    const afterReport = await app.inject({
      method: 'GET',
      url: '/api/reports/daily',
      headers: { cookie: adminCookie },
    })
    assert.equal(
      afterReport.json().revenueCents,
      before.json().revenueCents - order.json().totalCents,
    )
    assert.equal(afterReport.json().cancelledCount, 1)

    // Still visible, still fetchable, flagged in the CSV — and it says who.
    const fetched = await app.inject({
      method: 'GET',
      url: `/api/orders/${id}`,
      headers: { cookie: adminCookie },
    })
    assert.equal(fetched.statusCode, 200)
    assert.equal(fetched.json().cancelledByName, 'admin')

    const list = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: adminCookie },
    })
    const cancelledRow = list.json().orders.find((o: { id: number }) => o.id === id)
    assert.equal(cancelledRow.cancelledByName, 'admin')
    assert.ok(
      list.json().orders.every(
        (o: { cancelledAt: number | null; cancelledByName: string | null }) =>
          o.cancelledAt !== null || o.cancelledByName === null,
      ),
      'active orders must not carry a canceller name',
    )
    const csv = await app.inject({
      method: 'GET',
      url: '/api/reports/daily.csv',
      headers: { cookie: adminCookie },
    })
    const row = csv.body.split('\r\n').find((l: string) => l.includes('Da annullare'))!
    assert.ok(row.endsWith(';yes'), `cancelled flag missing: ${row}`)
  })

  // ---- password change ----

  it('changes own password only with the correct current password', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: opCookie },
      payload: { currentPassword: 'nope', newPassword: 'newpassword1' },
    })
    assert.equal(wrong.statusCode, 403)

    const short = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: opCookie },
      payload: { currentPassword: 'password123', newPassword: 'short' },
    })
    assert.equal(short.statusCode, 400)

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: opCookie },
      payload: { currentPassword: 'password123', newPassword: 'newpassword1' },
    })
    assert.equal(ok.statusCode, 200)

    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'marco', password: 'newpassword1' },
    })
    assert.equal(relogin.statusCode, 200)
  })

  // ---- reorder ----

  it('persists a drag-reorder of categories into the menu', async () => {
    const c2 = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { cookie: adminCookie },
      payload: { name: 'Antipasti' },
    })
    const id2 = c2.json().id

    const denied = await app.inject({
      method: 'PUT',
      url: '/api/categories/order',
      headers: { cookie: opCookie },
      payload: { ids: [id2, catId] },
    })
    assert.equal(denied.statusCode, 403)

    const res = await app.inject({
      method: 'PUT',
      url: '/api/categories/order',
      headers: { cookie: adminCookie },
      payload: { ids: [id2, catId] },
    })
    assert.equal(res.statusCode, 200)

    const menu = await app.inject({ method: 'GET', url: '/api/menu', headers: { cookie: adminCookie } })
    const names = menu.json().map((c: { name: string }) => c.name)
    assert.deepEqual(names, ['Antipasti', 'Drinks'])
  })
})
