import PDFDocument from 'pdfkit'
import type { Order, OrderItem } from '../db/schema.js'
import { imageBuffer, type AppSettings, type PaperSize } from '../settings.js'

/**
 * All print documents are rendered from the admin-configurable settings:
 * paper size, logo, header/footer text, background watermark and language.
 * The 80mm roll keeps its content-tight page height (a roll printer feeds
 * blank page space as wasted paper); fixed sizes get normal margins.
 */

const MM = 72 / 25.4
const CURRENCY = process.env.CURRENCY_SYMBOL ?? '€'

const LABELS = {
  it: {
    order: 'Ordine',
    customer: 'Cliente',
    covers: 'Coperti',
    coverCharge: 'Coperto',
    total: 'TOTALE',
    thanks: 'Grazie!',
    cancelled: 'ANNULLATO',
  },
  en: {
    order: 'Order',
    customer: 'Customer',
    covers: 'Covers',
    coverCharge: 'Cover charge',
    total: 'TOTAL',
    thanks: 'Thank you!',
    cancelled: 'CANCELLED',
  },
}

type Dims = { pageW: number; margin: number; innerW: number; fixedH: number | null }

function dimsFor(paper: PaperSize): Dims {
  switch (paper) {
    case 'roll80':
      return { pageW: 80 * MM, margin: 4 * MM, innerW: 72 * MM, fixedH: null }
    case 'a5':
      return { pageW: 419.53, margin: 15 * MM, innerW: 419.53 - 30 * MM, fixedH: 595.28 }
    case 'a4':
      return { pageW: 595.28, margin: 15 * MM, innerW: 595.28 - 30 * MM, fixedH: 841.89 }
    case 'letter':
      return { pageW: 612, margin: 15 * MM, innerW: 612 - 30 * MM, fixedH: 792 }
  }
}

function money(cents: number, lang: 'it' | 'en'): string {
  const amount = (cents / 100).toFixed(2)
  return `${CURRENCY} ${lang === 'it' ? amount.replace('.', ',') : amount}`
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

function drawBackground(doc: PDFKit.PDFDocument, s: AppSettings, pageW: number, pageH: number) {
  if (!s.backgroundImage) return
  const img = imageBuffer(s.backgroundImage)
  if (!img) return
  try {
    doc.save()
    doc.opacity(0.08)
    doc.image(img, 0, 0, { fit: [pageW, pageH], align: 'center', valign: 'center' })
    doc.restore()
  } catch {
    // A corrupt upload must never block a ticket from printing.
    doc.restore()
  }
}

function drawCancelledStamp(
  doc: PDFKit.PDFDocument,
  lang: 'it' | 'en',
  pageW: number,
  pageH: number,
) {
  const label = LABELS[lang].cancelled
  doc.save()
  doc.rotate(-25, { origin: [pageW / 2, pageH / 2] })
  doc.opacity(0.25)
  doc.font('Helvetica-Bold').fontSize(pageW / 7).fillColor('#cc0000')
  // Center by measurement with wrapping off — the rotated text box would
  // otherwise wrap the word against the page edge.
  const w = doc.widthOfString(label)
  doc.text(label, (pageW - w) / 2, pageH / 2 - pageW / 14, { lineBreak: false })
  doc.restore()
  doc.fillColor('#000')
}

/**
 * Renders one page. On roll paper the layout runs twice: once on an oversized
 * probe page to measure the content, then on a page exactly that tall.
 */
async function render(
  s: AppSettings,
  cancelled: boolean,
  layout: (doc: PDFKit.PDFDocument, d: Dims) => void,
): Promise<Buffer> {
  const d = dimsFor(s.paperSize)
  const opts = (height: number) => ({
    size: [d.pageW, height] as [number, number],
    margins: { top: d.margin, bottom: d.margin, left: d.margin, right: d.margin },
  })

  let pageH = d.fixedH
  if (pageH === null) {
    const probe = new PDFDocument(opts(3000))
    probe.on('data', () => {})
    layout(probe, d)
    pageH = Math.max(probe.y + d.margin * 2, 40 * MM)
    probe.end()
  }

  const doc = new PDFDocument(opts(pageH))
  const done = collect(doc)
  drawBackground(doc, s, d.pageW, pageH)
  layout(doc, d)
  if (cancelled) drawCancelledStamp(doc, s.pdfLang, d.pageW, pageH)
  doc.end()
  return done
}

function drawLogo(doc: PDFKit.PDFDocument, s: AppSettings, d: Dims) {
  if (!s.logoImage) return
  const img = imageBuffer(s.logoImage)
  if (!img) return
  const h = s.paperSize === 'roll80' ? 14 * MM : 20 * MM
  try {
    doc.image(img, d.pageW / 2 - h, doc.y, { fit: [h * 2, h], align: 'center' })
    doc.y += h + 4
  } catch {
    // ignore bad image data
  }
}

function dashes(doc: PDFKit.PDFDocument, d: Dims) {
  doc.moveDown(0.4)
  doc
    .moveTo(d.margin, doc.y)
    .lineTo(d.pageW - d.margin, doc.y)
    .dash(2, { space: 2 })
    .strokeColor('#000')
    .stroke()
    .undash()
  doc.moveDown(0.4)
}

/**
 * Kitchen ticket: what to make and for whom, in big type. No prices — the
 * kitchen does not care, and large glyphs survive steam and distance.
 */
export function renderKitchenTicket(
  order: Order,
  items: OrderItem[],
  s: AppSettings,
): Promise<Buffer> {
  const L = LABELS[s.pdfLang]
  return render(s, order.cancelledAt !== null, (doc, d) => {
    doc.font('Helvetica-Bold').fontSize(26).text(`#${ticketNo(order)}`, { align: 'center' })
    doc
      .font('Helvetica')
      .fontSize(12)
      .text(`${order.customerName ? `${order.customerName}  ·  ` : ''}${timeOf(order)}`, {
        align: 'center',
      })
    if (order.covers > 0) {
      doc.fontSize(11).text(`${L.covers}: ${order.covers}`, { align: 'center' })
    }

    dashes(doc, d)

    for (const item of items) {
      doc.font('Helvetica-Bold').fontSize(15).text(`${item.qty} × ${item.nameSnapshot}`)
      if (item.note) {
        doc.font('Helvetica-Oblique').fontSize(11).text(`   » ${item.note}`)
      }
      doc.moveDown(0.25)
    }

    if (order.note) {
      dashes(doc, d)
      doc.font('Helvetica-Oblique').fontSize(12).text(order.note)
    }
  })
}

/** Customer receipt: itemised with prices, coperto and the total. */
export function renderReceipt(order: Order, items: OrderItem[], s: AppSettings): Promise<Buffer> {
  const L = LABELS[s.pdfLang]
  const lang = s.pdfLang
  return render(s, order.cancelledAt !== null, (doc, d) => {
    drawLogo(doc, s, d)
    doc.font('Helvetica-Bold').fontSize(16).text(s.restaurantName, { align: 'center' })
    if (s.headerText) {
      doc.font('Helvetica').fontSize(9).fillColor('#444').text(s.headerText, { align: 'center' })
      doc.fillColor('#000')
    }
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(
        `${L.order} #${ticketNo(order)}${order.customerName ? ` · ${order.customerName}` : ''}`,
        { align: 'center' },
      )
      .text(`${order.serviceDay} · ${timeOf(order)}`, { align: 'center' })

    dashes(doc, d)

    const priceW = Math.min(22 * MM, d.innerW * 0.25)
    const line = (label: string, amountCents: number, opts?: { bold?: boolean; note?: string }) => {
      const y = doc.y
      doc
        .font(opts?.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(11)
        .text(label, d.margin, y, { width: d.innerW - priceW })
      const bottom = doc.y
      doc.text(money(amountCents, lang), d.margin + d.innerW - priceW, y, {
        width: priceW,
        align: 'right',
      })
      doc.y = Math.max(doc.y, bottom)
      doc.x = d.margin
      if (opts?.note) {
        doc.font('Helvetica-Oblique').fontSize(9).text(`   ${opts.note}`)
      }
      doc.moveDown(0.15)
    }

    for (const item of items) {
      line(`${item.qty} × ${item.nameSnapshot}`, item.priceCentsSnapshot * item.qty, {
        note: item.note ?? undefined,
      })
    }
    if (order.covers > 0 && order.coverChargeCents > 0) {
      line(`${order.covers} × ${L.coverCharge}`, order.covers * order.coverChargeCents)
    }

    dashes(doc, d)

    const y = doc.y
    doc.font('Helvetica-Bold').fontSize(14).text(L.total, d.margin, y)
    doc.text(money(order.totalCents, lang), d.margin, y, { width: d.innerW, align: 'right' })
    doc.x = d.margin

    doc.moveDown(0.8)
    if (s.footerText) {
      doc.font('Helvetica').fontSize(9).fillColor('#444').text(s.footerText, { align: 'center' })
      doc.fillColor('#000')
    }
    doc.font('Helvetica').fontSize(9).text(L.thanks, { align: 'center' })
  })
}
