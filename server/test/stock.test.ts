import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { login, makeTestApp, makeUser } from './helpers.js'

/**
 * Stock tracking (issue #31) and quantity reduction (issue #30): tracked
 * products decrement on every order, refuse orders they cannot cover, take
 * themselves off the menu at zero, and get their portions back when a line
 * is cancelled or reduced.
 */
describe('stock and quantity edits', () => {
  let app: FastifyInstance
  let close: () => void
  let adminCookie: string
  let marcoCookie: string
  let luciaCookie: string
  let chefCookie: string
  let trackedId: number

  async function stockOf(id: number): Promise<{ stockRemaining: number | null; active: boolean }> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/products?includeInactive=true',
      headers: { cookie: adminCookie },
    })
    const p = res.json().find((x: { id: number }) => x.id === id)
    return { stockRemaining: p.stockRemaining, active: p.active }
  }

  before(async () => {
    const t = await makeTestApp()
    app = t.app
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    await makeUser(t.db, 'marco', 'operator')
    await makeUser(t.db, 'lucia', 'operator')
    await makeUser(t.db, 'chef', 'kitchen')
    adminCookie = await login(app, 'admin')
    marcoCookie = await login(app, 'marco')
    luciaCookie = await login(app, 'lucia')
    chefCookie = await login(app, 'chef')

    const cat = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { cookie: adminCookie },
      payload: { name: 'Secondi' },
    })
    const steak = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { cookie: adminCookie },
      payload: { name: 'Bistecca', priceCents: 1200, categoryId: cat.json().id },
    })
    trackedId = steak.json().id
  })

  after(() => {
    void app.close()
    close()
  })

  it('starts untracked; the admin can set and unset a stock, junk is refused', async () => {
    assert.equal((await stockOf(trackedId)).stockRemaining, null)

    const set = await app.inject({
      method: 'PATCH',
      url: `/api/products/${trackedId}`,
      headers: { cookie: adminCookie },
      payload: { stockRemaining: 5 },
    })
    assert.equal(set.statusCode, 200)
    assert.equal(set.json().stockRemaining, 5)

    for (const bad of [-1, 2.5, 'ten']) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/products/${trackedId}`,
        headers: { cookie: adminCookie },
        payload: { stockRemaining: bad },
      })
      assert.equal(res.statusCode, 400, `${bad} should be rejected`)
    }
  })

  it('decrements on orders, refuses what it cannot cover, sells out at zero', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: marcoCookie },
      payload: { customerName: 'Rossi', items: [{ productId: trackedId, qty: 3 }] },
    })
    assert.equal(first.statusCode, 201)
    assert.equal((await stockOf(trackedId)).stockRemaining, 2)

    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: marcoCookie },
      payload: { customerName: 'Troppi', items: [{ productId: trackedId, qty: 3 }] },
    })
    assert.equal(tooMany.statusCode, 409)
    assert.equal(tooMany.json().error, 'out_of_stock')

    const last = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: marcoCookie },
      payload: { customerName: 'Ultimi', items: [{ productId: trackedId, qty: 2 }] },
    })
    assert.equal(last.statusCode, 201)
    const after = await stockOf(trackedId)
    assert.equal(after.stockRemaining, 0)
    assert.equal(after.active, false, 'sold out → off the menu')

    const menu = await app.inject({ method: 'GET', url: '/api/menu', headers: { cookie: marcoCookie } })
    const names = menu
      .json()
      .flatMap((c: { products: { name: string }[] }) => c.products.map((p) => p.name))
    assert.ok(!names.includes('Bistecca'))
  })

  it('cancelling a line restores the stock and puts the product back on the menu', async () => {
    // "Ultimi" (2×) is the order that emptied the stock.
    const list = await app.inject({ method: 'GET', url: '/api/orders', headers: { cookie: adminCookie } })
    const ultimi = list.json().orders.find((o: { customerName: string }) => o.customerName === 'Ultimi')
    const detail = await app.inject({
      method: 'GET',
      url: `/api/orders/${ultimi.id}`,
      headers: { cookie: adminCookie },
    })
    const itemId = detail.json().items[0].id

    const res = await app.inject({
      method: 'POST',
      url: `/api/orders/${ultimi.id}/items/${itemId}/cancel`,
      headers: { cookie: adminCookie },
    })
    assert.equal(res.statusCode, 200)

    const after = await stockOf(trackedId)
    assert.equal(after.stockRemaining, 2)
    assert.equal(after.active, true, 'restored stock → back on the menu')
  })

  it('reduces a quantity (own order only), restoring stock and recomputing the total', async () => {
    // Rossi has 3× Bistecca (stock currently 2).
    const list = await app.inject({ method: 'GET', url: '/api/orders', headers: { cookie: adminCookie } })
    const rossi = list.json().orders.find((o: { customerName: string }) => o.customerName === 'Rossi')
    const detail = await app.inject({
      method: 'GET',
      url: `/api/orders/${rossi.id}`,
      headers: { cookie: adminCookie },
    })
    const itemId = detail.json().items[0].id

    const denied = await app.inject({
      method: 'POST',
      url: `/api/orders/${rossi.id}/items/${itemId}/quantity`,
      headers: { cookie: luciaCookie },
      payload: { qty: 1 },
    })
    assert.equal(denied.statusCode, 403, "a colleague must not edit marco's order")

    // 0 and non-integers are junk; 3 equals the current quantity.
    for (const qty of [0, 3, 1.5]) {
      const bad = await app.inject({
        method: 'POST',
        url: `/api/orders/${rossi.id}/items/${itemId}/quantity`,
        headers: { cookie: marcoCookie },
        payload: { qty },
      })
      assert.equal(bad.statusCode, 400, `qty ${qty} should be rejected`)
    }

    const ok = await app.inject({
      method: 'POST',
      url: `/api/orders/${rossi.id}/items/${itemId}/quantity`,
      headers: { cookie: marcoCookie },
      payload: { qty: 1 },
    })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.json().totalCents, 1200, '3×→1× at 12.00 each')
    assert.equal(ok.json().items[0].qty, 1)
    assert.equal((await stockOf(trackedId)).stockRemaining, 4, 'the two portions came back')
  })

  it('increases a quantity, consuming stock and waking the kitchen back up', async () => {
    // Rossi is down to 1× Bistecca (stock 4). The kitchen finishes it…
    const list = await app.inject({ method: 'GET', url: '/api/orders', headers: { cookie: adminCookie } })
    const rossi = list.json().orders.find((o: { customerName: string }) => o.customerName === 'Rossi')
    const detail = await app.inject({
      method: 'GET',
      url: `/api/orders/${rossi.id}`,
      headers: { cookie: adminCookie },
    })
    const itemId = detail.json().items[0].id

    const done = await app.inject({
      method: 'PUT',
      url: `/api/kitchen/items/${itemId}`,
      headers: { cookie: chefCookie },
      payload: { done: true },
    })
    assert.equal(done.json().orderCompleted, true)

    // …then the table asks for two more: total and stock move, the line
    // returns to pending and the order is no longer completed.
    const more = await app.inject({
      method: 'POST',
      url: `/api/orders/${rossi.id}/items/${itemId}/quantity`,
      headers: { cookie: marcoCookie },
      payload: { qty: 3 },
    })
    assert.equal(more.statusCode, 200)
    assert.equal(more.json().totalCents, 3600)
    assert.equal(more.json().items[0].qty, 3)
    assert.equal(more.json().items[0].doneAt, null, 'more to cook → back to pending')
    assert.equal(more.json().completedAt, null, 'the order reopens for the kitchen')
    assert.equal((await stockOf(trackedId)).stockRemaining, 2)

    // Asking beyond the stock is refused atomically.
    const tooMany = await app.inject({
      method: 'POST',
      url: `/api/orders/${rossi.id}/items/${itemId}/quantity`,
      headers: { cookie: marcoCookie },
      payload: { qty: 10 },
    })
    assert.equal(tooMany.statusCode, 409)
    assert.equal(tooMany.json().error, 'out_of_stock')
    assert.equal((await stockOf(trackedId)).stockRemaining, 2, 'nothing consumed on refusal')
  })

  it('returns reserved stock when the whole order is cancelled', async () => {
    const cat = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { cookie: adminCookie },
      payload: { name: 'Dolci' },
    })
    const tiramisu = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { cookie: adminCookie },
      payload: { name: 'Tiramisù', priceCents: 400, categoryId: cat.json().id },
    })
    const id = tiramisu.json().id
    await app.inject({
      method: 'PATCH',
      url: `/api/products/${id}`,
      headers: { cookie: adminCookie },
      payload: { stockRemaining: 2 },
    })

    // Order the last two: stock hits 0 and the product drops off the menu.
    const order = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: marcoCookie },
      payload: { customerName: 'Bianchi', items: [{ productId: id, qty: 2 }] },
    })
    assert.equal(order.statusCode, 201)
    assert.deepEqual(await stockOf(id), { stockRemaining: 0, active: false })

    // Cancelling the whole order gives the portions back and re-lists it —
    // exactly like cancelling each line does.
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.json().id}/cancel`,
      headers: { cookie: adminCookie },
    })
    assert.equal(cancel.statusCode, 200)
    assert.deepEqual(await stockOf(id), { stockRemaining: 2, active: true })
  })
})
