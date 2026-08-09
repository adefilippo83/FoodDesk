import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../src/db/index.js'
import { orders } from '../src/db/schema.js'
import type { PaymentCheck, PaymentProvider, ProviderRegistry } from '../src/payments/provider.js'
import { login, makeTestApp, makeUser } from './helpers.js'

/**
 * The day's books once customers pay online: the report must split money by
 * where it physically is (drawer vs provider), include authorless self-orders,
 * and show refunds that went back out.
 */
function fakeProvider() {
  const checks = new Map<string, PaymentCheck>()
  let seq = 0
  const refunds: string[] = []
  const provider: PaymentProvider = {
    method: 'stripe',
    async createPayment() {
      const ref = `fake_${++seq}`
      checks.set(ref, 'pending')
      return { ref, redirectUrl: `https://pay.example/${ref}` }
    },
    async verifyPayment(ref) {
      return checks.get(ref) ?? 'pending'
    },
    async cancelPayment() {},
    async refund(ref) {
      refunds.push(ref)
    },
    async resumeUrl(ref) {
      return `https://pay.example/${ref}`
    },
  }
  return { provider, checks, refunds }
}

describe('reports with online payments', () => {
  let app: FastifyInstance
  let db: Db
  let close: () => void
  let adminCookie: string
  let fake: ReturnType<typeof fakeProvider>

  let ipSeq = 0
  const publicOrder = (name: string, payment: 'counter' | 'stripe') =>
    app.inject({
      method: 'POST',
      url: '/api/public/orders',
      remoteAddress: `10.42.2.${++ipSeq}`,
      payload: { customerName: name, covers: 1, payment, items: [{ productId: beerId, qty: 1 }] },
    })

  /** Provider confirms; the customer's next status poll finalizes the order. */
  const settle = async (created: { publicToken: string; paymentUrl: string }) => {
    fake.checks.set(created.paymentUrl.split('/').pop()!, 'paid')
    await app.inject({ method: 'GET', url: `/api/public/orders/${created.publicToken}` })
  }

  let beerId: number

  before(async () => {
    delete process.env.KITCHEN_PRINTER
    fake = fakeProvider()
    const registry: ProviderRegistry = new Map([['stripe', fake.provider]])
    const t = await makeTestApp({ paymentProviders: registry })
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
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { customerOrdering: true },
    })

    // The day: one staff order (drawer), one self-order paid at the counter
    // (drawer), two paid online — one of which staff then cancels (refund).
    await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: adminCookie },
      payload: { customerName: 'Staff table', items: [{ productId: beerId, qty: 2 }] },
    })

    const counter = await publicOrder('Counter Carla', 'counter')
    const counterId = (
      await db.select().from(orders).where(eq(orders.publicToken, counter.json().publicToken))
    )[0]!.id
    await app.inject({
      method: 'POST',
      url: `/api/orders/${counterId}/paid`,
      headers: { cookie: adminCookie },
    })

    await settle((await publicOrder('Online Olga', 'stripe')).json())

    const doomed = await publicOrder('Refund Rita', 'stripe')
    await settle(doomed.json())
    const doomedId = (
      await db.select().from(orders).where(eq(orders.publicToken, doomed.json().publicToken))
    )[0]!.id
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/orders/${doomedId}/cancel`,
      headers: { cookie: adminCookie },
    })
    assert.equal(cancelled.statusCode, 200)
    assert.equal(fake.refunds.length, 1)
  })

  after(() => {
    void app.close()
    close()
  })

  it('splits revenue by where the money is', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/daily',
      headers: { cookie: adminCookie },
    })
    const r = res.json()
    // Cancelled Rita is out of revenue; the other three count.
    assert.equal(r.ordersCount, 3)
    assert.equal(r.revenueCents, 2000)
    assert.deepEqual(r.byPayment, [
      { method: 'counter', ordersCount: 2, revenueCents: 1500 },
      { method: 'stripe', ordersCount: 1, revenueCents: 500 },
    ])
  })

  it('surfaces the refunded money', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/daily',
      headers: { cookie: adminCookie },
    })
    assert.equal(res.json().refundedCount, 1)
    assert.equal(res.json().refundedCents, 500)
  })

  it('keeps authorless self-orders in the CSV, with payment and refund flags', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/daily.csv',
      headers: { cookie: adminCookie },
    })
    const lines = res.body.trim().split('\r\n')
    assert.equal(lines.length, 5) // header + 4 orders × 1 line each

    const olga = lines.find((l) => l.includes('Online Olga'))!
    assert.ok(olga.includes(';stripe;'), `payment missing: ${olga}`)

    const rita = lines.find((l) => l.includes('Refund Rita'))!
    assert.ok(rita.endsWith(';yes;yes'), `cancel/refund flags missing: ${rita}`)

    const carla = lines.find((l) => l.includes('Counter Carla'))!
    assert.ok(carla.includes(';counter;'), `counter-paid self-order: ${carla}`)
  })
})
