import PDFDocument from 'pdfkit'
import type { Order, OrderItem } from '../db/schema.js'
import { imageBuffer, type AppSettings, type PaperSize, type PdfLang } from '../settings.js'

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
    note: 'Nota',
  },
  en: {
    order: 'Order',
    customer: 'Customer',
    covers: 'Covers',
    coverCharge: 'Cover charge',
    total: 'TOTAL',
    thanks: 'Thank you!',
    cancelled: 'CANCELLED',
    note: 'Note',
  },
  es: {
    order: 'Pedido',
    customer: 'Cliente',
    covers: 'Cubiertos',
    coverCharge: 'Cubierto',
    total: 'TOTAL',
    thanks: '¡Gracias!',
    cancelled: 'ANULADO',
    note: 'Nota',
  },
  fr: {
    order: 'Commande',
    customer: 'Client',
    covers: 'Couverts',
    coverCharge: 'Couvert',
    total: 'TOTAL',
    thanks: 'Merci !',
    cancelled: 'ANNULÉE',
    note: 'Note',
  },
  pt: {
    order: 'Pedido',
    customer: 'Cliente',
    covers: 'Couverts',
    coverCharge: 'Couvert',
    total: 'TOTAL',
    thanks: 'Obrigado!',
    cancelled: 'ANULADO',
    note: 'Nota',
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

function money(cents: number, lang: PdfLang): string {
  const amount = (cents / 100).toFixed(2)
  // Every supported language except English writes decimals with a comma.
  return `${CURRENCY} ${lang === 'en' ? amount : amount.replace('.', ',')}`
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

/**
 * Intrinsic pixel size of a PNG or JPEG buffer, so an image scaled to a
 * chosen width can advance the layout cursor by its real rendered height.
 */
function imageDims(buf: Buffer): { w: number; h: number } | null {
  // PNG: IHDR width/height right after the 16-byte signature+chunk header.
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  }
  // JPEG: scan markers for a start-of-frame segment.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      const marker = buf[i + 1]!
      if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2
        continue
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
      }
      i += 2 + buf.readUInt16BE(i + 2)
    }
  }
  return null
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
  lang: PdfLang,
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

/**
 * Order sheet (foglio ordine): the document produced when the order is taken.
 * Configurable header/footer (text and/or image), then order number/date/time/
 * customer, the coperto line first, products grouped by category — set apart
 * by alternating light-grey blocks or separator lines (orderCategoryStyle) —
 * a highlighted total, the kitchen note, and a disclaimer above the footer.
 */
export function renderOrderSheet(order: Order, items: OrderItem[], s: AppSettings): Promise<Buffer> {
  const L = LABELS[s.pdfLang]
  const lang = s.pdfLang
  return render(s, order.cancelledAt !== null, (doc, d) => {
    // Centered image scaled to a % of the printable width, height proportional.
    const scaledImage = (dataUrl: string, pct: number) => {
      const img = imageBuffer(dataUrl)
      if (!img) return
      const w = (d.innerW * pct) / 100
      const dims = imageDims(img)
      const h = dims ? (w * dims.h) / dims.w : (s.paperSize === 'roll80' ? 16 * MM : 24 * MM)
      const x = d.margin + (d.innerW - w) / 2
      try {
        if (dims) doc.image(img, x, doc.y, { width: w })
        else doc.image(img, x, doc.y, { fit: [w, h], align: 'center' })
        doc.y += h + 6
      } catch {
        // ignore bad image data
      }
    }

    // ---- header ----
    if (s.orderHeaderImage) scaledImage(s.orderHeaderImage, s.orderHeaderImageWidthPct)
    if (s.orderHeaderText) {
      doc
        .font('Helvetica')
        .fontSize(s.orderHeaderFontSize)
        .fillColor('#333')
        .text(s.orderHeaderText, d.margin, doc.y, { width: d.innerW, align: 'center' })
      doc.fillColor('#000')
      doc.moveDown(0.3)
    }

    // ---- order number · date · time · customer ----
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .text(
        `${L.order} #${ticketNo(order)} · ${order.serviceDay} · ${timeOf(order)}` +
          (order.customerName ? ` · ${order.customerName}` : ''),
        d.margin,
        doc.y,
        { width: d.innerW, align: 'center' },
      )

    dashes(doc, d)

    const priceW = Math.min(22 * MM, d.innerW * 0.25)
    const nameW = d.innerW - priceW
    const PAD = 4

    const line = (label: string, amountCents: number, note?: string) => {
      const y = doc.y
      doc
        .font('Helvetica')
        .fontSize(11)
        .text(label, d.margin + PAD, y, { width: nameW - PAD * 2 })
      const bottom = doc.y
      doc.text(money(amountCents, lang), d.margin + nameW, y, {
        width: priceW - PAD,
        align: 'right',
      })
      doc.y = Math.max(doc.y, bottom)
      if (note) {
        doc
          .font('Helvetica-Oblique')
          .fontSize(9)
          .text(`   » ${note}`, d.margin + PAD, doc.y, { width: nameW - PAD * 2 })
      }
      doc.y += 2
    }

    // Mirrors line() exactly so a background can be painted before rendering.
    const lineHeight = (label: string, note?: string) => {
      doc.font('Helvetica').fontSize(11)
      let h = Math.max(
        doc.heightOfString(label, { width: nameW - PAD * 2 }),
        doc.heightOfString('0', { width: priceW - PAD }),
      )
      if (note) {
        doc.font('Helvetica-Oblique').fontSize(9)
        h += doc.heightOfString(`   » ${note}`, { width: nameW - PAD * 2 })
      }
      return h + 2
    }

    // ---- coperto first ----
    if (order.covers > 0 && order.coverChargeCents > 0) {
      line(`${order.covers} × ${L.coverCharge}`, order.covers * order.coverChargeCents)
      doc.y += 2
    }

    // ---- products grouped by category (order of first appearance) ----
    const groups: Array<{ name: string; items: OrderItem[] }> = []
    for (const item of items) {
      const g = groups.find((x) => x.name === item.categoryNameSnapshot)
      if (g) g.items.push(item)
      else groups.push({ name: item.categoryNameSnapshot, items: [item] })
    }

    groups.forEach((g, i) => {
      if (s.orderCategoryStyle === 'separator' && i > 0) {
        doc
          .moveTo(d.margin, doc.y + 1)
          .lineTo(d.margin + d.innerW, doc.y + 1)
          .strokeColor('#999')
          .stroke()
        doc.y += 5
      }

      doc.font('Helvetica-Bold').fontSize(8)
      let blockH = doc.heightOfString(g.name.toUpperCase(), { width: nameW - PAD * 2 }) + 2
      for (const item of g.items) {
        blockH += lineHeight(`${item.qty} × ${item.nameSnapshot}`, item.note ?? undefined)
      }

      if (s.orderCategoryStyle === 'alternating' && i % 2 === 1) {
        doc.rect(d.margin, doc.y - PAD / 2, d.innerW, blockH + PAD).fill('#f0f0f0')
        doc.fillColor('#000')
      }

      doc
        .fillColor('#555')
        .font('Helvetica-Bold')
        .fontSize(8)
        .text(g.name.toUpperCase(), d.margin + PAD, doc.y, { width: nameW - PAD * 2 })
      doc.fillColor('#000')
      doc.y += 2
      for (const item of g.items) {
        line(`${item.qty} × ${item.nameSnapshot}`, item.priceCentsSnapshot * item.qty, item.note ?? undefined)
      }
      doc.y += PAD
    })

    // ---- total, highlighted ----
    doc.y += 2
    const totalH = 24
    const rectY = doc.y
    doc.rect(d.margin, rectY, d.innerW, totalH).fill('#e5e5e5')
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(14)
    doc.text(L.total, d.margin + PAD, rectY + 6, { width: d.innerW / 2 })
    doc.text(money(order.totalCents, lang), d.margin, rectY + 6, {
      width: d.innerW - PAD,
      align: 'right',
    })
    doc.x = d.margin
    doc.y = rectY + totalH + 6

    // ---- kitchen note ----
    if (order.note) {
      dashes(doc, d)
      doc
        .font('Helvetica-Oblique')
        .fontSize(11)
        .text(`${L.note}: ${order.note}`, d.margin, doc.y, { width: d.innerW })
      doc.moveDown(0.3)
    }

    // ---- disclaimer ----
    if (s.orderDisclaimer) {
      doc.moveDown(0.4)
      doc
        .font('Helvetica-Bold')
        .fontSize(s.orderDisclaimerFontSize)
        .fillColor('#555')
        .text(s.orderDisclaimer, d.margin, doc.y, { width: d.innerW, align: 'center' })
      doc.fillColor('#000')
    }

    // ---- footer ----
    if (s.orderFooterText) {
      doc.moveDown(0.5)
      doc
        .font('Helvetica')
        .fontSize(s.orderFooterFontSize)
        .fillColor('#444')
        .text(s.orderFooterText, d.margin, doc.y, { width: d.innerW, align: 'center' })
      doc.fillColor('#000')
    }
    if (s.orderFooterImage) {
      doc.y += 4
      scaledImage(s.orderFooterImage, s.orderFooterImageWidthPct)
    }
  })
}
