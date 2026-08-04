import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Order, OrderItem } from '../src/db/schema.js'
import { renderKitchenTicket, renderOrderSheet, renderReceipt } from '../src/print/pdf.js'
import type { AppSettings, PaperSize } from '../src/settings.js'

function makeSettings(paper: PaperSize): AppSettings {
  return {
    restaurantName: 'Sagra Test',
    coverChargeCents: 150,
    paperSize: paper,
    orderPaperSize: paper,
    kitchenPaperSize: paper,
    pdfLang: 'it',
    headerText: 'Header line',
    footerText: 'Footer line',
    logoImage: '',
    backgroundImage: '',
    orderHeaderText: 'Order header',
    orderHeaderImage: '',
    orderFooterText: 'Order footer',
    orderFooterImage: '',
    orderDisclaimer: 'Disclaimer text',
    orderCategoryStyle: 'alternating',
    orderHeaderFontSize: 10,
    orderFooterFontSize: 9,
    orderDisclaimerFontSize: 8,
    orderHeaderImageWidthPct: 100,
    orderFooterImageWidthPct: 100,
  }
}

function makeOrder(itemCount: number, cancelled = false): { order: Order; items: OrderItem[] } {
  const now = Math.floor(Date.now() / 1000)
  const order: Order = {
    id: 1,
    dailyNumber: 42,
    serviceDay: '2026-08-04',
    customerName: 'Mario Rossi',
    covers: 4,
    coverChargeCents: 150,
    cancelledAt: cancelled ? now : null,
    cancelledBy: null,
    completedAt: null,
    clientKey: null,
    note: 'no onions on half of these, please',
    totalCents: itemCount * 650 + 4 * 150,
    createdBy: 1,
    createdAt: now,
    printedAt: null,
    printError: null,
    printAttempts: 0,
  }
  const items: OrderItem[] = Array.from({ length: itemCount }, (_, i) => ({
    id: i + 1,
    orderId: 1,
    productId: 1,
    nameSnapshot: `Dish number ${i + 1} with a fairly long descriptive name`,
    priceCentsSnapshot: 650,
    categoryNameSnapshot: `Category ${Math.floor(i / 8) + 1}`,
    qty: (i % 3) + 1,
    note: i % 5 === 0 ? 'extra spicy' : null,
    doneAt: null,
    cancelledAt: null,
    cancelledBy: null,
  }))
  return { order, items }
}

function pageCount(buf: Buffer): number {
  return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
}

const RENDERERS = [
  ['receipt', renderReceipt],
  ['order sheet', renderOrderSheet],
  ['kitchen ticket', renderKitchenTicket],
] as const

describe('pdf pagination', () => {
  for (const paper of ['a4', 'a5', 'letter'] as const) {
    for (const [name, fn] of RENDERERS) {
      it(`flows a 60-item ${name} onto multiple ${paper} pages`, async () => {
        const { order, items } = makeOrder(60)
        const buf = await fn(order, items, makeSettings(paper))
        assert.ok(buf.subarray(0, 5).toString() === '%PDF-', 'missing PDF magic bytes')
        assert.ok(pageCount(buf) >= 2, `expected multiple pages, got ${pageCount(buf)}`)
      })
    }
  }

  for (const [name, fn] of RENDERERS) {
    it(`keeps a short ${name} on one a4 page`, async () => {
      const { order, items } = makeOrder(3)
      const buf = await fn(order, items, makeSettings('a4'))
      assert.equal(pageCount(buf), 1)
    })

    it(`keeps a 60-item ${name} on a single roll80 page`, async () => {
      const { order, items } = makeOrder(60)
      const buf = await fn(order, items, makeSettings('roll80'))
      assert.equal(pageCount(buf), 1)
    })

    it(`stamps a cancelled multi-page ${name} on every page`, async () => {
      const { order, items } = makeOrder(60, true)
      const plain = await fn(makeOrder(60).order, items, makeSettings('a4'))
      const cancelled = await fn(order, items, makeSettings('a4'))
      assert.equal(pageCount(cancelled), pageCount(plain))
      // The rotated ANNULLATO stamp adds drawing operations to every page, so
      // the cancelled render must be strictly larger than the plain one.
      assert.ok(cancelled.length > plain.length)
    })
  }

  it('renders the maximum order (100 items, all noted) on every format', async () => {
    for (const paper of ['roll80', 'a4', 'a5', 'letter'] as const) {
      const { order, items } = makeOrder(100)
      for (const item of items) item.note = 'a fairly long per-item kitchen note here'
      for (const [, fn] of RENDERERS) {
        const buf = await fn(order, items, makeSettings(paper))
        assert.ok(buf.subarray(0, 5).toString() === '%PDF-')
        if (paper === 'roll80') assert.equal(pageCount(buf), 1)
      }
    }
  })
})
