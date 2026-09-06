import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../src/db/index.js'
import { loadOrderItemsInMenuOrder } from '../src/lib/orderItems.js'
import { login, makeTestApp, makeUser } from './helpers.js'

/**
 * Printed sheets list lines in MENU order — the categories and products as
 * the Menu tab shows them — never in the order the operator tapped them.
 * Covers the shared loader behind the three PDFs, the CUPS ticket, and the
 * order detail the browser print fallback renders from.
 */
describe('printed sheets follow the menu order', () => {
  let app: FastifyInstance
  let db: Db
  let close: () => void
  let cookie: string
  const cat: Record<string, number> = {}
  const prod: Record<string, number> = {}

  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, headers: { cookie }, payload })
  const patch = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url, headers: { cookie }, payload })

  const namesOf = (items: { nameSnapshot: string }[]) => items.map((i) => i.nameSnapshot)

  /** Places an order tapping the products in the given (deliberate) order. */
  const orderTapping = async (...names: string[]) => {
    const res = await post('/api/orders', {
      customerName: 'Tavolo 7',
      items: names.map((n) => ({ productId: prod[n], qty: 1 })),
    })
    assert.equal(res.statusCode, 201)
    return res.json().id as number
  }

  before(async () => {
    const t = await makeTestApp()
    app = t.app
    db = t.db
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    cookie = await login(app, 'admin')

    // Menu: Antipasti → Primi → Secondi, two products each, in this order.
    for (const [name, sortOrder] of [['Antipasti', 0], ['Primi', 1], ['Secondi', 2]] as const) {
      cat[name] = (await post('/api/categories', { name, sortOrder })).json().id
    }
    const menu: Array<[string, string, number]> = [
      ['Bruschetta', 'Antipasti', 0],
      ['Tagliere', 'Antipasti', 1],
      ['Lasagne', 'Primi', 0],
      ['Risotto', 'Primi', 1],
      ['Bistecca', 'Secondi', 0],
      ['Salsiccia', 'Secondi', 1],
    ]
    for (const [name, c, sortOrder] of menu) {
      prod[name] = (
        await post('/api/products', { name, priceCents: 500, categoryId: cat[c], sortOrder })
      ).json().id
    }
  })

  after(() => {
    void app.close()
    close()
  })

  const MENU_ORDER = ['Bruschetta', 'Tagliere', 'Lasagne', 'Risotto', 'Bistecca', 'Salsiccia']

  it('lists lines by category and product order, not by tap order', async () => {
    // Scrambled across AND within categories.
    const id = await orderTapping('Salsiccia', 'Risotto', 'Tagliere', 'Bistecca', 'Lasagne', 'Bruschetta')
    assert.deepEqual(namesOf(await loadOrderItemsInMenuOrder(db, id)), MENU_ORDER)
  })

  it('returns the CREATED order in menu order — the sheet auto-printed right after placing it', async () => {
    // Without a CUPS printer the waiter's browser prints the order sheet from
    // this very response, not from a later GET. Tap order scrambled across
    // and within categories.
    const res = await post('/api/orders', {
      customerName: 'Tavolo 7',
      items: ['Salsiccia', 'Risotto', 'Tagliere', 'Bistecca', 'Lasagne', 'Bruschetta'].map((n) => ({
        productId: prod[n],
        qty: 1,
      })),
    })
    assert.equal(res.statusCode, 201)
    assert.deepEqual(namesOf(res.json().items), MENU_ORDER)
  })

  it('replays a retried submission in menu order too', async () => {
    const payload = {
      customerName: 'Retry Remo',
      clientKey: 'menu-order-replay-key',
      items: ['Bistecca', 'Bruschetta', 'Risotto'].map((n) => ({ productId: prod[n], qty: 1 })),
    }
    const first = await post('/api/orders', payload)
    assert.equal(first.statusCode, 201)
    const again = await post('/api/orders', payload)
    assert.equal(again.statusCode, 200, 'a replay answers 200')
    assert.deepEqual(namesOf(again.json().items), ['Bruschetta', 'Risotto', 'Bistecca'])
  })

  it('serves the order detail — what the browser print fallback renders — in menu order', async () => {
    const id = await orderTapping('Bistecca', 'Bruschetta', 'Risotto')
    const res = await app.inject({ method: 'GET', url: `/api/orders/${id}`, headers: { cookie } })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(namesOf(res.json().items), ['Bruschetta', 'Risotto', 'Bistecca'])
  })

  it('renders all three printed documents for a scrambled order', async () => {
    const id = await orderTapping('Salsiccia', 'Bruschetta', 'Lasagne')
    for (const kind of ['receipt', 'kitchen', 'order']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/orders/${id}/${kind}.pdf`,
        headers: { cookie },
      })
      assert.equal(res.statusCode, 200, kind)
      assert.equal(res.rawPayload.subarray(0, 5).toString(), '%PDF-', kind)
    }
  })

  it('follows the menu as it is NOW: reordering the menu reorders the sheet', async () => {
    const id = await orderTapping('Bruschetta', 'Lasagne', 'Bistecca')
    assert.deepEqual(namesOf(await loadOrderItemsInMenuOrder(db, id)), [
      'Bruschetta',
      'Lasagne',
      'Bistecca',
    ])

    // The venue moves Secondi to the top of the menu.
    assert.equal((await patch(`/api/categories/${cat.Secondi}`, { sortOrder: -1 })).statusCode, 200)
    assert.deepEqual(namesOf(await loadOrderItemsInMenuOrder(db, id)), [
      'Bistecca',
      'Bruschetta',
      'Lasagne',
    ])
    // ...and puts it back.
    assert.equal((await patch(`/api/categories/${cat.Secondi}`, { sortOrder: 2 })).statusCode, 200)
  })

  it('breaks ties the way the Menu tab does: by name', async () => {
    // Two products sharing a sort order inside one category.
    assert.equal((await patch(`/api/products/${prod.Tagliere}`, { sortOrder: 0 })).statusCode, 200)
    try {
      const id = await orderTapping('Tagliere', 'Bruschetta')
      // Same sortOrder (0) → alphabetical, exactly like the Menu tab.
      assert.deepEqual(namesOf(await loadOrderItemsInMenuOrder(db, id)), ['Bruschetta', 'Tagliere'])
    } finally {
      await patch(`/api/products/${prod.Tagliere}`, { sortOrder: 1 })
    }
  })

  it('never drops a line whose product was retired from the menu', async () => {
    const id = await orderTapping('Risotto', 'Bruschetta')
    // A product with order lines is soft-deleted, never removed.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/products/${prod.Risotto}`,
      headers: { cookie },
    })
    assert.equal(del.statusCode, 200)
    assert.equal(del.json().deactivated, true)
    assert.deepEqual(namesOf(await loadOrderItemsInMenuOrder(db, id)), ['Bruschetta', 'Risotto'])
    // Restore for later tests.
    await patch(`/api/products/${prod.Risotto}`, { active: true })
  })
})
