import PDFDocument from 'pdfkit'
import type { Order, OrderItem } from '../db/schema.js'

/**
 * Both documents are laid out for 80mm thermal roll paper (72.1mm printable),
 * which is also perfectly readable printed on A4 from a browser. The page
 * height is computed from the content so a roll printer cuts right after the
 * last line instead of feeding blank paper.
 */

const MM = 72 / 25.4
const PAGE_W = 80 * MM
const MARGIN = 4 * MM
const INNER_W = PAGE_W - MARGIN * 2

const RESTAURANT_NAME = process.env.RESTAURANT_NAME ?? 'FoodDesk'
const CURRENCY = process.env.CURRENCY_SYMBOL ?? '€'

function money(cents: number): string {
  return `${CURRENCY}${(cents / 100).toFixed(2)}`
}

function timeOf(order: Order): string {
  return new Date(order.createdAt * 1000).toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function ticketNo(order: Order): string {
  return String(order.dailyNumber).padStart(3, '0')
}

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
}

/**
 * Thermal rolls cut at the end of the page, so blank page space is fed as
 * wasted paper. Lay the content out twice: once on an oversized page to
 * measure where it ends, then again on a page exactly that tall.
 */
async function renderTight(layout: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const opts = (height: number) => ({
    size: [PAGE_W, height] as [number, number],
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
  })

  const probe = new PDFDocument(opts(2000))
  probe.on('data', () => {})
  layout(probe)
  const height = Math.max(probe.y + MARGIN * 2, 40 * MM)
  probe.end()

  const doc = new PDFDocument(opts(height))
  const done = collect(doc)
  layout(doc)
  doc.end()
  return done
}

function dashes(doc: PDFKit.PDFDocument) {
  doc.moveDown(0.4)
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_W - MARGIN, doc.y)
    .dash(2, { space: 2 })
    .strokeColor('#000')
    .stroke()
    .undash()
  doc.moveDown(0.4)
}

/**
 * Kitchen ticket: what to make, for which table, in big type. No prices —
 * the kitchen does not care, and large glyphs survive steam and distance.
 */
export function renderKitchenTicket(order: Order, items: OrderItem[]): Promise<Buffer> {
  return renderTight((doc) => {
    doc.font('Helvetica-Bold').fontSize(26).text(`#${ticketNo(order)}`, { align: 'center' })
    doc
      .font('Helvetica')
      .fontSize(12)
      .text(`${order.tableLabel ? `Table ${order.tableLabel}  ·  ` : ''}${timeOf(order)}`, {
        align: 'center',
      })

    dashes(doc)

    for (const item of items) {
      doc.font('Helvetica-Bold').fontSize(15).text(`${item.qty} × ${item.nameSnapshot}`)
      if (item.note) {
        doc.font('Helvetica-Oblique').fontSize(11).text(`   » ${item.note}`)
      }
      doc.moveDown(0.25)
    }

    if (order.note) {
      dashes(doc)
      doc.font('Helvetica-Oblique').fontSize(12).text(order.note)
    }
  })
}

/** Customer receipt: itemised with prices and the total. */
export function renderReceipt(order: Order, items: OrderItem[]): Promise<Buffer> {
  return renderTight((doc) => {
    doc.font('Helvetica-Bold').fontSize(16).text(RESTAURANT_NAME, { align: 'center' })
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(`Order #${ticketNo(order)}${order.tableLabel ? ` · Table ${order.tableLabel}` : ''}`, {
        align: 'center',
      })
      .text(`${order.serviceDay} · ${timeOf(order)}`, { align: 'center' })

    dashes(doc)

    const priceW = 18 * MM
    for (const item of items) {
      const y = doc.y
      doc
        .font('Helvetica')
        .fontSize(11)
        .text(`${item.qty} × ${item.nameSnapshot}`, MARGIN, y, { width: INNER_W - priceW })
      const rowBottom = doc.y
      doc.text(money(item.priceCentsSnapshot * item.qty), MARGIN + INNER_W - priceW, y, {
        width: priceW,
        align: 'right',
      })
      doc.y = Math.max(doc.y, rowBottom)
      doc.x = MARGIN
      if (item.note) {
        doc.font('Helvetica-Oblique').fontSize(9).text(`   ${item.note}`)
      }
      doc.moveDown(0.15)
    }

    dashes(doc)

    const y = doc.y
    doc.font('Helvetica-Bold').fontSize(14).text('TOTAL', MARGIN, y)
    doc.text(money(order.totalCents), MARGIN, y, { width: INNER_W, align: 'right' })
    doc.x = MARGIN

    doc.moveDown(0.8)
    doc.font('Helvetica').fontSize(9).text('Grazie!', { align: 'center' })
  })
}
