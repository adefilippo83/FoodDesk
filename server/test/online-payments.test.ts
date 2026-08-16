import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../src/db/index.js'
import { orders, products } from '../src/db/schema.js'
import { sweepHeldOrders } from '../src/payments/lifecycle.js'
import type { PaymentCheck, PaymentProvider, ProviderRegistry } from '../src/payments/provider.js'
import { login, makeTestApp, makeUser } from './helpers.js'

/** A fully controllable in-memory provider standing in for Stripe. */
function fakeProvider() {
  const state = {
    checks: new Map<string, PaymentCheck>(),
    refunds: [] as string[],
    cancels: [] as string[],
    cancelThrows: false,
    createThrows: false,
    seq: 0,
  }
  const provider: PaymentProvider = {
    method: 'stripe',
    async createPayment() {
      if (state.createThrows) throw new Error('provider down')
      const ref = `fake_${++state.seq}`
      state.checks.set(ref, 'pending')
      return { ref, redirectUrl: `https://pay.example/${ref}` }
    },
    async verifyPayment(ref) {
      return state.checks.get(ref) ?? 'pending'
    },
    async cancelPayment(ref) {
      if (state.cancelThrows) throw new Error('already completed')
      state.cancels.push(ref)
    },
    async refund(ref) {
      if (ref === 'refuse-refund') throw new Error('refund refused')
      state.refunds.push(ref)
    },
    async resumeUrl(ref) {
      return `https://pay.example/${ref}`
    },
  }
  return { provider, state }
}

describe('online payments (phase B, fake provider)', () => {
  let app: FastifyInstance
  let db: Db
  let close: () => void
  let adminCookie: string
  let kitchenCookie: string
  let beerId: number
  let fake: ReturnType<typeof fakeProvider>
  let registry: ProviderRegistry

  let ipSeq = 100
  const createOrder = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/public/orders',
      remoteAddress: `10.42.1.${(ipSeq++ % 250) + 1}`,
      payload: {
        customerName: 'Pia',
        covers: 1,
        payment: 'stripe',
        items: [{ productId: beerId, qty: 1 }],
        ...payload,
      },
    })

  const status = (token: string) =>
    app.inject({ method: 'GET', url: `/api/public/orders/${token}` })

  const stockOf = async () =>
    (await db.select().from(products).where(eq(products.id, beerId)))[0]!.stockRemaining

  before(async () => {
    delete process.env.KITCHEN_PRINTER
    delete process.env.CUSTOMER_ORDER_CAP
    fake = fakeProvider()
    registry = new Map([['stripe', fake.provider]])
    const t = await makeTestApp({ paymentProviders: registry })
    app = t.app
    db = t.db
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    await makeUser(t.db, 'cucina', 'kitchen')
    adminCookie = await login(app, 'admin')
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
    // Track stock so held-order accounting is observable.
    await app.inject({
      method: 'PATCH',
      url: `/api/products/${beerId}`,
      headers: { cookie: adminCookie },
      payload: { stockRemaining: 50 },
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

  beforeEach(() => {
    fake.state.cancelThrows = false
    fake.state.createThrows = false
  })

  it('advertises the configured provider on the public menu', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/public/menu' })
    assert.deepEqual(res.json().paymentMethods, ['counter', 'stripe'])
  })

  it('holds a paying order out of sight until the money is verified', async () => {
    const before = await stockOf()
    const created = await createOrder({})
    assert.equal(created.statusCode, 201)
    const { publicToken, paymentUrl } = created.json()
    assert.ok(paymentUrl.startsWith('https://pay.example/'))
    assert.equal(await stockOf(), before! - 1) // stock reserved while held

    // Staff see the payment in progress, flagged held; the kitchen never
    // sees it until the money is confirmed.
    const listed = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: adminCookie },
    })
    const heldRow = listed
      .json()
      .orders.find((o: { customerName: string }) => o.customerName === 'Pia')
    assert.ok(heldRow, 'held order should be listed for awareness')
    assert.equal(heldRow.held, true)
    assert.equal(heldRow.paymentRef, undefined, 'provider ref must stay server-side')
    const kds = await app.inject({
      method: 'GET',
      url: '/api/kitchen/orders',
      headers: { cookie: kitchenCookie },
    })
    assert.ok(!kds.json().orders.some((o: { customerName: string }) => o.customerName === 'Pia'))

    // The customer sees a pending payment with a resume link.
    let st = await status(publicToken)
    assert.equal(st.json().paymentState, 'pending')
    assert.ok(st.json().paymentUrl)

    // Provider confirms → the next poll releases the order.
    const ref = paymentUrl.split('/').pop()!
    fake.state.checks.set(ref, 'paid')
    st = await status(publicToken)
    assert.equal(st.json().paymentState, 'paid')
    assert.ok(st.json().paidAt !== null)

    const listedAfter = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: adminCookie },
    })
    const visible = listedAfter
      .json()
      .orders.find((o: { customerName: string }) => o.customerName === 'Pia')
    assert.ok(visible, 'paid order should be staff-visible')
    assert.equal(visible.paymentMethod, 'stripe')
    assert.equal(visible.held, false)
    const kdsAfter = await app.inject({
      method: 'GET',
      url: '/api/kitchen/orders',
      headers: { cookie: kitchenCookie },
    })
    assert.ok(
      kdsAfter.json().orders.some((o: { customerName: string }) => o.customerName === 'Pia'),
      'paid order should reach the kitchen',
    )
  })

  it('a failed payment cancels the order and restores its stock', async () => {
    const before = await stockOf()
    const created = await createOrder({ customerName: 'Ugo' })
    const ref = created.json().paymentUrl.split('/').pop()!
    assert.equal(await stockOf(), before! - 1)

    fake.state.checks.set(ref, 'failed')
    const st = await status(created.json().publicToken)
    assert.equal(st.json().paymentState, 'failed')
    assert.ok(st.json().cancelledAt !== null)
    assert.equal(await stockOf(), before)
  })

  it('expires an unpaid held order after the TTL, provider first', async () => {
    const before = await stockOf()
    const created = await createOrder({ customerName: 'Rita' })
    const ref = created.json().paymentUrl.split('/').pop()!

    // Backdate past the TTL; provider still says pending.
    await db
      .update(orders)
      .set({ createdAt: Math.floor(Date.now() / 1000) - 16 * 60 })
      .where(eq(orders.publicToken, created.json().publicToken))
    const st = await status(created.json().publicToken)
    assert.equal(st.json().paymentState, 'failed')
    assert.ok(fake.state.cancels.includes(ref), 'provider cancel must precede expiry')
    assert.equal(await stockOf(), before)
  })

  it('stays held when the provider cannot guarantee cancellation', async () => {
    const created = await createOrder({ customerName: 'Nino' })
    await db
      .update(orders)
      .set({ createdAt: Math.floor(Date.now() / 1000) - 16 * 60 })
      .where(eq(orders.publicToken, created.json().publicToken))
    fake.state.cancelThrows = true
    const st = await status(created.json().publicToken)
    // Not expired: the payment might be completing right now.
    assert.equal(st.json().paymentState, 'pending')
    assert.equal(st.json().cancelledAt, null)
    // Once the provider reports paid, the order is delivered, late or not.
    const ref = (await db
      .select()
      .from(orders)
      .where(eq(orders.publicToken, created.json().publicToken)))[0]!.paymentRef!
    fake.state.checks.set(ref, 'paid')
    const st2 = await status(created.json().publicToken)
    assert.equal(st2.json().paymentState, 'paid')
  })

  it('the sweeper releases paid orders without any customer polling', async () => {
    const created = await createOrder({ customerName: 'Sara' })
    const ref = created.json().paymentUrl.split('/').pop()!
    fake.state.checks.set(ref, 'paid')
    await sweepHeldOrders(db, registry)
    const st = await status(created.json().publicToken)
    assert.equal(st.json().paymentState, 'paid')
  })

  it('manager cancel of a paid order refunds automatically', async () => {
    const created = await createOrder({ customerName: 'Vera' })
    const ref = created.json().paymentUrl.split('/').pop()!
    fake.state.checks.set(ref, 'paid')
    await status(created.json().publicToken)

    const row = (await db
      .select()
      .from(orders)
      .where(eq(orders.publicToken, created.json().publicToken)))[0]!
    const res = await app.inject({
      method: 'POST',
      url: `/api/orders/${row.id}/cancel`,
      headers: { cookie: adminCookie },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().refundFailed, undefined)
    assert.ok(fake.state.refunds.includes(ref))
    const after = (await db.select().from(orders).where(eq(orders.id, row.id)))[0]!
    assert.ok(after.refundedAt !== null)
  })

  it('reports a refund the provider refused', async () => {
    const created = await createOrder({ customerName: 'Zeno' })
    const token = created.json().publicToken
    const row = (await db.select().from(orders).where(eq(orders.publicToken, token)))[0]!
    // Force the awkward ref, mark paid.
    await db.update(orders).set({ paymentRef: 'refuse-refund' }).where(eq(orders.id, row.id))
    fake.state.checks.set('refuse-refund', 'paid')
    await status(token)

    const res = await app.inject({
      method: 'POST',
      url: `/api/orders/${row.id}/cancel`,
      headers: { cookie: adminCookie },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().refundFailed, true)
  })

  it('locks line edits on online-paid orders — full cancel or nothing', async () => {
    const created = await createOrder({ customerName: 'Olga' })
    const ref = created.json().paymentUrl.split('/').pop()!
    fake.state.checks.set(ref, 'paid')
    await status(created.json().publicToken)
    const row = (await db
      .select()
      .from(orders)
      .where(eq(orders.publicToken, created.json().publicToken)))[0]!
    const items = await app.inject({
      method: 'GET',
      url: `/api/orders/${row.id}`,
      headers: { cookie: adminCookie },
    })
    const itemId = items.json().items[0].id
    const res = await app.inject({
      method: 'POST',
      url: `/api/orders/${row.id}/items/${itemId}/cancel`,
      headers: { cookie: adminCookie },
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error, 'online_paid_locked')
  })

  it('fails closed when the provider cannot create the payment', async () => {
    const before = await stockOf()
    fake.state.createThrows = true
    const created = await createOrder({ customerName: 'Bice' })
    assert.equal(created.statusCode, 503)
    assert.equal(created.json().error, 'payment_unavailable')
    assert.equal(await stockOf(), before) // rolled back
  })

  it('rejects online payment when no provider is configured', async () => {
    const bare = await makeTestApp({ paymentProviders: new Map() })
    try {
      await makeUser(bare.db, 'admin', 'admin')
      const cookie = await login(bare.app, 'admin')
      await bare.app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { cookie },
        payload: { customerOrdering: true },
      })
      const menu = await bare.app.inject({ method: 'GET', url: '/api/public/menu' })
      assert.deepEqual(menu.json().paymentMethods, ['counter'])
      const res = await bare.app.inject({
        method: 'POST',
        url: '/api/public/orders',
        payload: {
          customerName: 'X',
          covers: 1,
          payment: 'stripe',
          items: [{ productId: 1, qty: 1 }],
        },
      })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error, 'payment_unavailable')
    } finally {
      void bare.app.close()
      bare.close()
    }
  })

  /** The held row's order id, via the staff list (held rows are listed flagged). */
  const heldOrderId = async (customerName: string) => {
    const listed = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: adminCookie },
    })
    const row = listed
      .json()
      .orders.find((o: { customerName: string }) => o.customerName === customerName)
    assert.ok(row, 'held order should be listed for staff')
    assert.equal(row.held, true)
    return row.id as number
  }

  it('manager cancel of a held order kills the checkout, restocks, and blocks late payment', async () => {
    const before = await stockOf()
    const refundsBefore = fake.state.refunds.length
    const created = await createOrder({ customerName: 'Held Hilda' })
    const { publicToken, paymentUrl } = created.json()
    const ref = paymentUrl.split('/').pop()!
    assert.equal(await stockOf(), before! - 1) // reserved while held

    const id = await heldOrderId('Held Hilda')
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/orders/${id}/cancel`,
      headers: { cookie: adminCookie },
    })
    assert.equal(cancel.statusCode, 200)

    // The provider checkout was cancelled (Stripe: session expired) so the
    // customer cannot pay after the cancel, and the stock came back.
    assert.ok(fake.state.cancels.includes(ref), 'provider checkout must be cancelled')
    assert.equal(await stockOf(), before!) // restocked

    // Even if the provider now reports paid, the cancelled order never flips
    // to paid, and nothing was captured so no refund was needed.
    fake.state.checks.set(ref, 'paid')
    const st = await status(publicToken)
    assert.equal(st.json().paymentState, 'failed')
    assert.equal(fake.state.refunds.length, refundsBefore) // nothing captured → nothing to refund
  })

  it('refuses to cancel a held order whose payment is completing, keeping it recoverable', async () => {
    const before = await stockOf()
    const created = await createOrder({ customerName: 'Racing Rina' })
    const { publicToken, paymentUrl } = created.json()
    const ref = paymentUrl.split('/').pop()!
    const id = await heldOrderId('Racing Rina')

    // Provider refuses the cancel: the payment is already completing.
    fake.state.cancelThrows = true
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/orders/${id}/cancel`,
      headers: { cookie: adminCookie },
    })
    assert.equal(cancel.statusCode, 409)
    assert.equal(cancel.json().error, 'payment_in_progress')
    // Still held, stock still reserved — the money is not lost.
    assert.equal(await stockOf(), before! - 1)
    assert.equal((await heldOrderId('Racing Rina')) > 0, true)

    // The payment completes; the next poll delivers the order to the kitchen.
    fake.state.cancelThrows = false
    fake.state.checks.set(ref, 'paid')
    const st = await status(publicToken)
    assert.equal(st.json().paymentState, 'paid')
  })

  it('never leaks paymentRef, clientKey or publicToken from the order detail', async () => {
    const created = await createOrder({ customerName: 'Leaky Lena' })
    const { publicToken, paymentUrl } = created.json()
    const ref = paymentUrl.split('/').pop()!
    const id = await heldOrderId('Leaky Lena')
    fake.state.checks.set(ref, 'paid')
    await status(publicToken) // finalize

    const detail = await app.inject({
      method: 'GET',
      url: `/api/orders/${id}`,
      headers: { cookie: adminCookie },
    })
    assert.equal(detail.statusCode, 200)
    const body = detail.json()
    assert.equal(body.paymentRef, undefined, 'provider reference must not leak')
    assert.equal(body.clientKey, undefined, 'idempotency key must not leak')
    assert.equal(body.publicToken, undefined, 'the follow-your-order token must not leak')
    assert.equal(body.paymentMethod, 'stripe', 'non-sensitive fields are still present')
  })
})
