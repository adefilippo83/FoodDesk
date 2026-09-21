import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { after, before, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../src/db/index.js'
import { orders } from '../src/db/schema.js'
import { login, makeTestApp, makeUser } from './helpers.js'

/**
 * Cash vs POS at the register (issue #63): the cashier says how the customer
 * paid, the order carries it, the books split the drawer from the terminal,
 * and the printed documents say it. A POS payment is a counter payment —
 * a person with the terminal in hand — never an "online" one: nothing gets
 * frozen or auto-refunded.
 */

/**
 * The text runs of a PDFKit document. Content streams are deflated and each
 * run is a kerned TJ array of hex strings; joining the hex pieces of one
 * array gives the run back verbatim (WinAnsi, so latin1 is right for these
 * labels).
 */
function pdfRuns(buf: Buffer): string[] {
  const src = buf.toString('latin1')
  const streams: string[] = []
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length
    const end = src.indexOf('endstream', start)
    const chunk = buf.subarray(start, end)
    try {
      streams.push(zlib.inflateSync(chunk).toString('latin1'))
    } catch {
      streams.push(chunk.toString('latin1'))
    }
  }
  const runs: string[] = []
  for (const line of streams.join('\n').split('\n')) {
    if (!/\]\s*TJ$/.test(line)) continue
    const hex = [...line.matchAll(/<([0-9a-fA-F]+)>/g)].map((h) => h[1]).join('')
    runs.push(Buffer.from(hex, 'hex').toString('latin1'))
  }
  return runs
}

describe('cash and POS at the register', () => {
  let app: FastifyInstance
  let db: Db
  let close: () => void
  let cookie: string
  let beerId: number
  let ipSeq = 0

  const post = (url: string, payload?: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, headers: { cookie }, payload })
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } })

  const staffOrder = (payload: Record<string, unknown> = {}) =>
    post('/api/orders', {
      customerName: 'Tavolo 4',
      items: [{ productId: beerId, qty: 2 }],
      ...payload,
    })

  /** A customer self-order to be paid at the counter; returns its row id. */
  const counterOrder = async (name: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      remoteAddress: `10.63.0.${++ipSeq}`,
      payload: { customerName: name, covers: 1, payment: 'counter', items: [{ productId: beerId, qty: 1 }] },
    })
    assert.equal(res.statusCode, 201)
    const row = (
      await db.select().from(orders).where(eq(orders.publicToken, res.json().publicToken))
    )[0]!
    return row.id
  }

  before(async () => {
    delete process.env.KITCHEN_PRINTER
    const t = await makeTestApp()
    app = t.app
    db = t.db
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    cookie = await login(app, 'admin')
    const cat = await post('/api/categories', { name: 'Bar' })
    beerId = (await post('/api/products', { name: 'Birra', priceCents: 500, categoryId: cat.json().id })).json().id
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { customerOrdering: true, pdfLang: 'it' },
    })
  })

  after(() => {
    void app.close()
    close()
  })

  it('a staff order is born paid in cash when the cashier says nothing', async () => {
    const res = await staffOrder()
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().paymentMethod, 'cash')
    assert.ok(res.json().paidAt, 'paid at the register, so paidAt must be stamped')
  })

  it('records a POS payment when the cashier picks it', async () => {
    const res = await staffOrder({ payment: 'pos' })
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().paymentMethod, 'pos')
    assert.ok(res.json().paidAt)
    const stored = await get(`/api/orders/${res.json().id}`)
    assert.equal(stored.json().paymentMethod, 'pos')
  })

  it('rejects anything but cash or pos from the register', async () => {
    for (const payment of ['stripe', 'paypal', 'card', 42, '']) {
      const res = await staffOrder({ payment })
      assert.equal(res.statusCode, 400, `payment=${JSON.stringify(payment)}`)
      assert.equal(res.json().error, 'invalid_payment')
    }
  })

  it('a POS-paid order stays editable — it is not an online payment', async () => {
    const created = (await staffOrder({ payment: 'pos', items: [{ productId: beerId, qty: 3 }] })).json()
    const line = created.items[0]
    const fewer = await post(`/api/orders/${created.id}/items/${line.id}/quantity`, { qty: 2 })
    assert.equal(fewer.statusCode, 200, fewer.body)
    assert.equal(fewer.json().totalCents, 1000)
    const gone = await post(`/api/orders/${created.id}/items/${line.id}/cancel`)
    assert.equal(gone.statusCode, 200, gone.body)
    assert.equal(gone.json().cancelledAt !== null, true, 'last line gone → order cancelled')
    // No provider, no refund: the cashier handles the money by hand.
    assert.equal(gone.json().refundedAt ?? null, null)
  })

  it('mark-paid at the counter records cash by default and POS on request', async () => {
    const cashId = await counterOrder('Carla')
    const cash = await post(`/api/orders/${cashId}/paid`)
    assert.equal(cash.statusCode, 200)
    assert.equal(cash.json().paymentMethod, 'cash')

    const posId = await counterOrder('Piero')
    const pos = await post(`/api/orders/${posId}/paid`, { payment: 'pos' })
    assert.equal(pos.statusCode, 200)
    assert.equal(pos.json().paymentMethod, 'pos')
    assert.ok(pos.json().paidAt)

    // Idempotent: paying again (even "differently") changes nothing.
    const again = await post(`/api/orders/${posId}/paid`, { payment: 'cash' })
    assert.equal(again.statusCode, 200)
    assert.equal(again.json().paymentMethod, 'pos')

    const badId = await counterOrder('Bianca')
    const bad = await post(`/api/orders/${badId}/paid`, { payment: 'stripe' })
    assert.equal(bad.statusCode, 400)
    assert.equal(bad.json().error, 'invalid_payment')
  })

  it('the receipt and the order sheet say how it was paid; the kitchen ticket does not', async () => {
    const pos = (await staffOrder({ payment: 'pos' })).json()
    const cash = (await staffOrder()).json()

    const runsOf = async (id: number, kind: string) => {
      const res = await get(`/api/orders/${id}/${kind}.pdf`)
      assert.equal(res.statusCode, 200)
      return pdfRuns(res.rawPayload)
    }
    for (const kind of ['receipt', 'order']) {
      assert.ok((await runsOf(pos.id, kind)).includes('Pagamento: POS'), `${kind} of a POS order`)
      assert.ok((await runsOf(cash.id, kind)).includes('Pagamento: Contanti'), `${kind} of a cash order`)
    }
    // The kitchen never sees money — and a POS payment is not "prepaid"
    // in the online sense: nothing to hand straight over without paying.
    const kitchen = await runsOf(pos.id, 'kitchen')
    assert.ok(!kitchen.some((r) => r.includes('PREPAGATO')), 'kitchen ticket must not stamp PREPAGATO')
    assert.ok(!kitchen.some((r) => r.includes('Pagamento')), 'kitchen ticket carries no payment line')
  })

  it('prints no payment line for an order from before the method was recorded', async () => {
    const legacy = (await staffOrder()).json()
    await db.update(orders).set({ paymentMethod: null, paidAt: null }).where(eq(orders.id, legacy.id))
    const res = await get(`/api/orders/${legacy.id}/receipt.pdf`)
    assert.equal(res.statusCode, 200)
    assert.ok(!pdfRuns(res.rawPayload).some((r) => r.startsWith('Pagamento')))
  })

  it('the day report splits the drawer from the POS terminal', async () => {
    // A day of its own, so the orders above do not blur the numbers.
    const t = await makeTestApp()
    await makeUser(t.db, 'admin', 'admin')
    const c = await login(t.app, 'admin')
    const p = (url: string, payload?: Record<string, unknown>) =>
      t.app.inject({ method: 'POST', url, headers: { cookie: c }, payload })
    const cat = await p('/api/categories', { name: 'Bar' })
    const beer = (await p('/api/products', { name: 'Birra', priceCents: 500, categoryId: cat.json().id })).json().id
    const order = (payment?: string) =>
      p('/api/orders', { customerName: 'X', items: [{ productId: beer, qty: 1 }], ...(payment ? { payment } : {}) })

    await order()
    await order('cash')
    await order('pos')
    // An order from a pre-0.2.9 install: paid at the counter, method unknown.
    const legacy = (await order()).json()
    await t.db.update(orders).set({ paymentMethod: null }).where(eq(orders.id, legacy.id))

    const report = (await t.app.inject({ method: 'GET', url: '/api/reports/daily', headers: { cookie: c } })).json()
    const byPayment = Object.fromEntries(
      report.byPayment.map((b: { method: string; ordersCount: number; revenueCents: number }) => [
        b.method,
        { ordersCount: b.ordersCount, revenueCents: b.revenueCents },
      ]),
    )
    assert.deepEqual(byPayment, {
      cash: { ordersCount: 2, revenueCents: 1000 },
      pos: { ordersCount: 1, revenueCents: 500 },
      counter: { ordersCount: 1, revenueCents: 500 },
    })

    const csv = (await t.app.inject({ method: 'GET', url: '/api/reports/daily.csv', headers: { cookie: c } })).body
    const payments = csv
      .trim()
      .split('\r\n')
      .slice(1)
      .map((line) => line.split(';')[4])
    assert.deepEqual(payments, ['cash', 'cash', 'pos', 'counter'])

    const pdf = await t.app.inject({ method: 'GET', url: '/api/reports/daily.pdf', headers: { cookie: c } })
    const runs = pdfRuns(pdf.rawPayload)
    for (const label of ['Contanti', 'POS', 'Cassa']) {
      assert.ok(runs.includes(label), `report PDF names the "${label}" bucket`)
    }

    await t.app.close()
    t.close()
  })
})
