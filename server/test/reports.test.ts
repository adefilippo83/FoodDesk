import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { login, makeTestApp, makeUser } from './helpers.js'

describe('reports', () => {
  let app: FastifyInstance
  let close: () => void
  let adminCookie: string
  let opCookie: string

  before(async () => {
    const t = await makeTestApp()
    app = t.app
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    await makeUser(t.db, 'marco', 'operator')
    await makeUser(t.db, 'lucia', 'operator')
    adminCookie = await login(app, 'admin')
    opCookie = await login(app, 'marco')
    const luciaCookie = await login(app, 'lucia')

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
      payload: { name: 'Wine; "Riserva"', priceCents: 750, categoryId: cat.json().id },
    })

    // marco: 2 beers + 1 wine = 1750. lucia: 3 beers = 1500. Day total 3250.
    await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: opCookie },
      payload: {
        tableLabel: 'Bar; outside',
        items: [
          { productId: beer.json().id, qty: 2 },
          { productId: wine.json().id, qty: 1 },
        ],
      },
    })
    await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: luciaCookie },
      payload: { items: [{ productId: beer.json().id, qty: 3 }] },
    })
  })

  after(() => {
    void app.close()
    close()
  })

  for (const url of ['/api/reports/daily', '/api/reports/daily.csv', '/api/reports/days']) {
    it(`forbids an operator from ${url}`, async () => {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: opCookie } })
      assert.equal(res.statusCode, 403)
    })
  }

  it('totals the day correctly', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/daily',
      headers: { cookie: adminCookie },
    })
    const r = res.json()
    assert.equal(r.ordersCount, 2)
    assert.equal(r.revenueCents, 3250)
    assert.equal(r.avgOrderCents, 1625)
  })

  it('aggregates products across orders', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/daily',
      headers: { cookie: adminCookie },
    })
    const beerRow = res.json().byProduct.find((p: { name: string }) => p.name.startsWith('Beer'))
    assert.equal(beerRow.qty, 5)
    assert.equal(beerRow.revenueCents, 2500)
  })

  it('attributes orders and revenue per waiter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/daily',
      headers: { cookie: adminCookie },
    })
    const byWaiter = res.json().byWaiter
    const marco = byWaiter.find((w: { name: string }) => w.name === 'marco')
    const lucia = byWaiter.find((w: { name: string }) => w.name === 'lucia')
    assert.deepEqual(
      { m: [marco.ordersCount, marco.revenueCents], l: [lucia.ordersCount, lucia.revenueCents] },
      { m: [1, 1750], l: [1, 1500] },
    )
  })

  it('returns zeros for a day with no orders', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/daily?day=2001-01-01',
      headers: { cookie: adminCookie },
    })
    const r = res.json()
    assert.equal(r.ordersCount, 0)
    assert.equal(r.revenueCents, 0)
    assert.equal(r.avgOrderCents, 0)
  })

  it('rejects a malformed day', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/daily?day=DROP%20TABLE',
      headers: { cookie: adminCookie },
    })
    assert.equal(res.statusCode, 400)
  })

  it('exports CSV with quoted fields and decimal-comma money', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/daily.csv',
      headers: { cookie: adminCookie },
    })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /text\/csv/)

    const lines = res.body.trim().split('\r\n')
    // header + 3 item lines (2 from marco's order, 1 from lucia's)
    assert.equal(lines.length, 4)
    assert.equal(
      lines[0],
      'order;time;table;waiter;category;item;qty;unit_price;line_total',
    )
    // Fields containing ; or " must be quoted and doubled.
    const wineLine = lines.find((l) => l.includes('Riserva'))!
    assert.ok(wineLine.includes('"Wine; ""Riserva"""'), `bad quoting: ${wineLine}`)
    assert.ok(wineLine.includes('"Bar; outside"'), `table not quoted: ${wineLine}`)
    // 3 beers at 5,00 = 15,00
    const luciaLine = lines.find((l) => l.includes('lucia'))!
    assert.ok(luciaLine.endsWith(';3;5,00;15,00'), `bad money format: ${luciaLine}`)
  })

  it('lists service days with counts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/days',
      headers: { cookie: adminCookie },
    })
    assert.equal(res.json().length, 1)
    assert.equal(res.json()[0].ordersCount, 2)
    assert.equal(res.json()[0].revenueCents, 3250)
  })
})
