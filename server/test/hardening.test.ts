import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../src/db/index.js'
import { orderItems, orders, products } from '../src/db/schema.js'
import { sweepHeldOrders, verifyHeldOrder } from '../src/payments/lifecycle.js'
import type { PaymentCheck, PaymentProvider, ProviderRegistry } from '../src/payments/provider.js'
import { login, makeTestApp, makeUser } from './helpers.js'

/**
 * Regressions for the second review pass: guards on the kitchen display,
 * one-refund-per-cancel, the order cap letting retries through, held orders
 * whose provider disappeared, and a cancelled order owing nothing.
 */
function fakeProvider() {
  const state = {
    checks: new Map<string, PaymentCheck>(),
    refunds: [] as string[],
    seq: 0,
    lastReturnUrl: '',
  }
  const provider: PaymentProvider = {
    method: 'stripe',
    async createPayment(_order, returnUrl) {
      state.lastReturnUrl = returnUrl
      const ref = `fake_${++state.seq}`
      state.checks.set(ref, 'pending')
      return { ref, redirectUrl: `https://pay.example/${ref}` }
    },
    async verifyPayment(ref) {
      return state.checks.get(ref) ?? 'pending'
    },
    async cancelPayment() {},
    async refund(ref) {
      state.refunds.push(ref)
    },
    async resumeUrl(ref) {
      return `https://pay.example/${ref}`
    },
  }
  return { provider, state }
}

describe('hardening regressions', () => {
  let app: FastifyInstance
  let db: Db
  let close: () => void
  let adminCookie: string
  let kitchenCookie: string
  let beerId: number
  let fake: ReturnType<typeof fakeProvider>
  let registry: ProviderRegistry
  let ip = 0

  const stockOf = async () =>
    (await db.select().from(products).where(eq(products.id, beerId)))[0]!.stockRemaining

  const staffOrder = async (customerName: string, qty = 1) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: adminCookie },
      payload: { customerName, items: [{ productId: beerId, qty }] },
    })
    assert.equal(res.statusCode, 201)
    return res.json()
  }

  /** A customer order that is held: created with an online payment, unpaid. */
  const heldOrder = async (customerName: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      remoteAddress: `10.7.0.${++ip}`,
      payload: {
        customerName,
        covers: 1,
        payment: 'stripe',
        items: [{ productId: beerId, qty: 1 }],
      },
    })
    assert.equal(res.statusCode, 201)
    const body = res.json()
    const row = (
      await db.select().from(orders).where(eq(orders.publicToken, body.publicToken)).limit(1)
    )[0]!
    return { ...body, id: row.id, ref: body.paymentUrl.split('/').pop()! as string }
  }

  before(async () => {
    delete process.env.KITCHEN_PRINTER
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
    await app.inject({
      method: 'PATCH',
      url: `/api/products/${beerId}`,
      headers: { cookie: adminCookie },
      payload: { stockRemaining: 200 },
    })
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { customerOrdering: true, coverChargeCents: 150 },
    })
  })

  after(() => {
    void app.close()
    close()
  })

  const toggle = (itemId: number) =>
    app.inject({
      method: 'PUT',
      url: `/api/kitchen/items/${itemId}`,
      headers: { cookie: kitchenCookie },
      payload: { done: true },
    })

  it('refuses a kitchen tick on a cancelled order', async () => {
    const order = await staffOrder('Cancelled Carla')
    await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/cancel`,
      headers: { cookie: adminCookie },
    })
    const res = await toggle(order.items[0].id)
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error, 'order_cancelled')
  })

  it('refuses a kitchen tick on a previous service day', async () => {
    const order = await staffOrder('Yesterday Yuri')
    await db.update(orders).set({ serviceDay: '2001-01-01' }).where(eq(orders.id, order.id))
    const res = await toggle(order.items[0].id)
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error, 'stale_service_day')
  })

  it('hides a held order from the kitchen display entirely', async () => {
    const held = await heldOrder('Held Hilda')
    const item = (await db.select().from(orderItems).where(eq(orderItems.orderId, held.id)))[0]!
    const res = await toggle(item.id)
    assert.equal(res.statusCode, 404, 'a held order must not even be acknowledged')
  })

  it('refunds exactly once when two cancels race', async () => {
    const held = await heldOrder('Racing Rosa')
    fake.state.checks.set(held.ref, 'paid')
    await app.inject({ method: 'GET', url: `/api/public/orders/${held.publicToken}` }) // finalize
    const before = fake.state.refunds.length

    const cancel = () =>
      app.inject({
        method: 'POST',
        url: `/api/orders/${held.id}/cancel`,
        headers: { cookie: adminCookie },
      })
    const [a, b] = await Promise.all([cancel(), cancel()])

    assert.equal(a.statusCode, 200)
    assert.equal(b.statusCode, 200)
    assert.equal(
      fake.state.refunds.length,
      before + 1,
      'a racing double cancel must not refund the customer twice',
    )
  })

  it('owes nothing — not even the coperto — once the last line is cancelled', async () => {
    const order = await staffOrder('Coperto Clara')
    assert.ok(order.totalCents > 0)
    const res = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/items/${order.items[0].id}/cancel`,
      headers: { cookie: adminCookie },
    })
    assert.equal(res.statusCode, 200)
    assert.ok(res.json().cancelledAt !== null, 'the order cancels with its last line')
    assert.equal(res.json().totalCents, 0, 'no phantom cover charge on a cancelled order')
  })

  it('lets a retry through even when the order cap is full', async () => {
    const payload = {
      customerName: 'Retry Rita',
      covers: 1,
      payment: 'counter',
      clientKey: 'cap-retry-key',
      items: [{ productId: beerId, qty: 1 }],
    }
    // The order lands while there is still room.
    const first = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      remoteAddress: `10.7.1.${++ip}`,
      payload,
    })
    assert.equal(first.statusCode, 201)

    // Now the venue fills up.
    process.env.CUSTOMER_ORDER_CAP = '1'
    try {
      // A NEW order is refused...
      const other = await app.inject({
        method: 'POST',
        url: '/api/public/orders',
        remoteAddress: `10.7.2.${++ip}`,
        payload: { ...payload, clientKey: 'different-key', customerName: 'Other' },
      })
      assert.equal(other.statusCode, 503)
      assert.equal(other.json().error, 'venue_busy')

      // ...but the customer's own retry replays the order they already placed,
      // instead of stranding them with an order they cannot see.
      const retry = await app.inject({
        method: 'POST',
        url: '/api/public/orders',
        remoteAddress: `10.7.3.${++ip}`,
        payload,
      })
      assert.equal(retry.statusCode, 200, 'a retry must not be turned away by the cap')
      assert.equal(retry.json().publicToken, first.json().publicToken)
    } finally {
      delete process.env.CUSTOMER_ORDER_CAP
    }
  })

  it('releases a held order whose provider vanished, but only after the grace', async () => {
    const held = await heldOrder('Orphan Olga')
    const before = await stockOf()
    registry.delete('stripe') // the venue removed the key from the environment
    try {
      let row = (await db.select().from(orders).where(eq(orders.id, held.id)).limit(1))[0]!
      assert.equal(await verifyHeldOrder(db, registry, row), 'pending', 'fresh: stays held')
      assert.equal(await stockOf(), before, 'stock still reserved while held')

      // Older than the grace: the provider's own checkout is long gone.
      await db
        .update(orders)
        .set({ createdAt: Math.floor(Date.now() / 1000) - 25 * 60 * 60 })
        .where(eq(orders.id, held.id))
      row = (await db.select().from(orders).where(eq(orders.id, held.id)).limit(1))[0]!
      assert.equal(await verifyHeldOrder(db, registry, row), 'expired')
      assert.equal(await stockOf(), before! + 1, 'the reserved portion comes back')
    } finally {
      registry.set('stripe', fake.provider)
    }
  })

  it('keeps a held order out of the day report and the days listing', async () => {
    const beforeReport = await app.inject({
      method: 'GET',
      url: '/api/reports/daily',
      headers: { cookie: adminCookie },
    })
    const beforeRevenue = beforeReport.json().revenueCents

    await heldOrder('Invisible Ivo')

    const after = await app.inject({
      method: 'GET',
      url: '/api/reports/daily',
      headers: { cookie: adminCookie },
    })
    assert.equal(
      after.json().revenueCents,
      beforeRevenue,
      'money that is still in flight is not revenue',
    )

    // The day picker must agree with the dashboard for that same day. (A day
    // with nothing to show is simply absent from the listing.)
    const serviceDay = after.json().serviceDay
    const days = await app.inject({
      method: 'GET',
      url: '/api/reports/days',
      headers: { cookie: adminCookie },
    })
    const today = days.json().find((d: { serviceDay: string }) => d.serviceDay === serviceDay)
    assert.equal(today?.revenueCents ?? 0, after.json().revenueCents)
  })

  it('refuses to mark an online-payment order paid at the counter', async () => {
    const held = await heldOrder('Bypass Bruno')
    const res = await app.inject({
      method: 'POST',
      url: `/api/orders/${held.id}/paid`,
      headers: { cookie: adminCookie },
    })
    // Held orders are invisible to staff routes; once paid online the guard
    // below is what refuses a second, cash payment.
    assert.equal(res.statusCode, 404)

    fake.state.checks.set(held.ref, 'paid')
    await app.inject({ method: 'GET', url: `/api/public/orders/${held.publicToken}` })
    const paidAgain = await app.inject({
      method: 'POST',
      url: `/api/orders/${held.id}/paid`,
      headers: { cookie: adminCookie },
    })
    assert.equal(paidAgain.statusCode, 200, 'already paid: idempotent, not a second charge')
    assert.equal(paidAgain.json().paymentMethod, 'stripe', 'still recorded as the online payment')
  })

  it('freezes the lines of an online-paid order against quantity edits', async () => {
    const held = await heldOrder('Frozen Fabio')
    fake.state.checks.set(held.ref, 'paid')
    await app.inject({ method: 'GET', url: `/api/public/orders/${held.publicToken}` })
    const item = (await db.select().from(orderItems).where(eq(orderItems.orderId, held.id)))[0]!

    const res = await app.inject({
      method: 'POST',
      url: `/api/orders/${held.id}/items/${item.id}/quantity`,
      headers: { cookie: adminCookie },
      payload: { qty: 3 },
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error, 'online_paid_locked')
  })

  const orderWithHost = async (host: string, who: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      remoteAddress: `10.7.9.${++ip}`,
      headers: { host },
      payload: {
        customerName: who,
        covers: 1,
        payment: 'stripe',
        items: [{ productId: beerId, qty: 1 }],
      },
    })
    assert.equal(res.statusCode, 201)
    return fake.state.lastReturnUrl
  }

  it('never lets a forged Host header decide where the customer is sent back', async () => {
    // Perfectly well-formed, entirely attacker-chosen: the case that matters.
    // An attacker could otherwise mint a payment link and hand it to a victim
    // who really pays and is then dropped on the attacker's page.
    for (const host of [
      'attacker.test',
      'evil.example.com:8443',
      'fooddesk.fly.dev.attacker.test',
      'evil.example.com/../@attacker.test',
    ]) {
      const url = await orderWithHost(host, `Forged ${host}`)
      assert.ok(
        !url.includes('attacker') && !url.includes('evil.example.com'),
        `return URL followed a forged Host ${host}: ${url}`,
      )
      assert.match(url, /\/o\/[A-Za-z0-9_-]{20,}$/)
    }
  })

  it('still returns customers to the venue address they actually used', async () => {
    // The appliance has no fixed name: phones reach it by LAN IP or mDNS,
    // and nginx passes that Host through. Those must keep working.
    for (const host of ['10.42.0.1', 'fooddesk.local', '192.168.1.50:8080']) {
      const url = await orderWithHost(host, `Local ${host}`)
      assert.ok(url.startsWith(`http://${host}/o/`), `lost the venue address: ${url}`)
    }
  })

  it('uses PUBLIC_BASE_URL when the venue has a real domain in front', async () => {
    process.env.PUBLIC_BASE_URL = 'https://ordini.example.com/'
    try {
      const url = await orderWithHost('attacker.test', 'Domain Dora')
      assert.ok(url.startsWith('https://ordini.example.com/o/'), url)
    } finally {
      delete process.env.PUBLIC_BASE_URL
    }
  })

  it('keeps the customer status page out of shared caches', async () => {
    const held = await heldOrder('Private Piero')
    const res = await app.inject({
      method: 'GET',
      url: `/api/public/orders/${held.publicToken}`,
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
  })

  it('will not replay one surface\'s idempotency key on another', async () => {
    const key = 'shared-key-42'
    const staff = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: adminCookie },
      payload: { customerName: 'Staff Sara', clientKey: key, items: [{ productId: beerId, qty: 1 }] },
    })
    assert.equal(staff.statusCode, 201)

    // A customer presenting the same key must not receive the staff order.
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      remoteAddress: `10.7.8.${++ip}`,
      payload: {
        customerName: 'Sneaky Sam',
        covers: 1,
        payment: 'counter',
        clientKey: key,
        items: [{ productId: beerId, qty: 1 }],
      },
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error, 'payload_mismatch')
    assert.equal(res.json().publicToken, undefined, 'no token from another surface leaks out')
  })

  it('closes the whole public surface when self-ordering is switched off', async () => {
    const held = await heldOrder('Shutter Sara')
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { customerOrdering: false },
    })
    try {
      for (const url of [
        '/api/public/menu',
        `/api/public/orders/${held.publicToken}`,
        `/api/public/orders/${held.publicToken}/events`,
      ]) {
        const res = await app.inject({ method: 'GET', url })
        assert.equal(res.statusCode, 404, `${url} should not exist while the feature is off`)
      }
      const create = await app.inject({
        method: 'POST',
        url: '/api/public/orders',
        remoteAddress: `10.7.6.${++ip}`,
        payload: {
          customerName: 'Nope',
          covers: 1,
          payment: 'counter',
          items: [{ productId: beerId, qty: 1 }],
        },
      })
      assert.equal(create.statusCode, 404)
    } finally {
      await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { cookie: adminCookie },
        payload: { customerOrdering: true },
      })
    }
  })

  it('hands a held order its checkout link again when the customer retries', async () => {
    const payload = {
      customerName: 'Resume Renzo',
      covers: 1,
      payment: 'stripe',
      clientKey: 'resume-key-1',
      items: [{ productId: beerId, qty: 1 }],
    }
    const first = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      remoteAddress: `10.7.5.${++ip}`,
      payload,
    })
    assert.equal(first.statusCode, 201)

    // Same submission again (page reload mid-checkout): the customer gets the
    // SAME order back, with a link to finish paying — never a second order.
    const again = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      remoteAddress: `10.7.5.${++ip}`,
      payload,
    })
    assert.equal(again.statusCode, 200)
    assert.equal(again.json().publicToken, first.json().publicToken)
    assert.ok(again.json().paymentUrl, 'a held replay must offer the resume URL')
  })

  it('sweeps an abandoned checkout, restocking and re-listing a sold-out product', async () => {
    // A product with exactly one portion left: the order sells it out.
    const cat = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { cookie: adminCookie },
      payload: { name: 'Ultimi' },
    })
    const last = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { cookie: adminCookie },
      payload: { name: 'Ultima porzione', priceCents: 700, categoryId: cat.json().id },
    })
    const lastId = last.json().id
    await app.inject({
      method: 'PATCH',
      url: `/api/products/${lastId}`,
      headers: { cookie: adminCookie },
      payload: { stockRemaining: 1 },
    })

    const created = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      remoteAddress: `10.7.4.${++ip}`,
      payload: {
        customerName: 'Abandoned Aldo',
        covers: 1,
        payment: 'stripe',
        items: [{ productId: lastId, qty: 1 }],
      },
    })
    assert.equal(created.statusCode, 201)
    const soldOut = (await db.select().from(products).where(eq(products.id, lastId)))[0]!
    assert.equal(soldOut.stockRemaining, 0)
    assert.equal(soldOut.active, false, 'it took itself off the menu')

    // The customer never came back; the order ages past its hold.
    const row = (
      await db.select().from(orders).where(eq(orders.publicToken, created.json().publicToken)).limit(1)
    )[0]!
    await db
      .update(orders)
      .set({ createdAt: Math.floor(Date.now() / 1000) - 20 * 60 })
      .where(eq(orders.id, row.id))

    await sweepHeldOrders(db, registry)

    const back = (await db.select().from(products).where(eq(products.id, lastId)))[0]!
    assert.equal(back.stockRemaining, 1, 'the portion is for sale again')
    assert.equal(back.active, true, 'and the product is back on the menu')
    const after = (await db.select().from(orders).where(eq(orders.id, row.id)).limit(1))[0]!
    assert.ok(after.cancelledAt !== null)
  })

  it('survives a provider that throws during a sweep', async () => {
    const held = await heldOrder('Exploding Elio')
    const original = fake.provider.verifyPayment
    fake.provider.verifyPayment = async () => {
      throw new Error('provider on fire')
    }
    try {
      await sweepHeldOrders(db, registry) // must not reject
      const row = (await db.select().from(orders).where(eq(orders.id, held.id)).limit(1))[0]!
      assert.equal(row.cancelledAt, null, 'a provider error must not cancel the order')
      assert.equal(row.paidAt, null)
    } finally {
      fake.provider.verifyPayment = original
    }
  })

  it('keeps an unpaid counter order off the kitchen display AND untickable', async () => {
    // The display hides every unpaid customer order, not just the ones with a
    // checkout in flight — the tick guard has to hide exactly the same set, or
    // a kitchen account can mark food ready that nobody has paid for.
    const created = await app.inject({
      method: 'POST',
      url: '/api/public/orders',
      remoteAddress: `10.7.7.${++ip}`,
      payload: {
        customerName: 'Unpaid Ugo',
        covers: 1,
        payment: 'counter',
        items: [{ productId: beerId, qty: 1 }],
      },
    })
    assert.equal(created.statusCode, 201)
    const row = (
      await db.select().from(orders).where(eq(orders.publicToken, created.json().publicToken)).limit(1)
    )[0]!

    const kds = await app.inject({
      method: 'GET',
      url: '/api/kitchen/orders',
      headers: { cookie: kitchenCookie },
    })
    assert.ok(
      !kds.json().orders.some((o: { id: number }) => o.id === row.id),
      'an unpaid counter order is not on the display',
    )

    const item = (await db.select().from(orderItems).where(eq(orderItems.orderId, row.id)))[0]!
    const res = await toggle(item.id)
    assert.equal(res.statusCode, 404, 'and it cannot be ticked either')

    const after = (await db.select().from(orders).where(eq(orders.id, row.id)).limit(1))[0]!
    assert.equal(after.completedAt, null, 'the customer must not see "ready" for unpaid food')
  })

  it('releases provider-orphaned orders through the sweeper, not only a live poll', async () => {
    const held = await heldOrder('Forgotten Fulvio')
    const before = await stockOf()
    // The venue removed its only payment key: the registry is now EMPTY,
    // which is exactly when these orders need releasing.
    const emptyRegistry: ProviderRegistry = new Map()
    await db
      .update(orders)
      .set({ createdAt: Math.floor(Date.now() / 1000) - 72 * 60 * 60 })
      .where(eq(orders.id, held.id))

    await sweepHeldOrders(db, emptyRegistry)

    const row = (await db.select().from(orders).where(eq(orders.id, held.id)).limit(1))[0]!
    assert.ok(row.cancelledAt !== null, 'the sweeper must still run with no providers configured')
    assert.equal(await stockOf(), before! + 1, 'and give the reserved portion back')
  })
})
