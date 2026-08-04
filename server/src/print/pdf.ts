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

/**
 * On fixed page sizes, starts a new page when fewer than `h` points remain.
 * Layouts measure each block before drawing it and call this, so a row and
 * its right-aligned price can never be torn across a page boundary (PDFKit's
 * automatic break would strand the price on the wrong page). Roll paper is a
 * single content-tall page — always a no-op there.
 */
function ensureRoom(doc: PDFKit.PDFDocument, d: Dims, h: number): boolean {
  if (d.fixedH === null) return false
  if (doc.y + h <= d.fixedH - d.margin) return false
  doc.addPage()
  return true
}

/** "1 / 3" centered inside the bottom margin — multi-page fixed sizes only. */
function drawPageNumber(doc: PDFKit.PDFDocument, d: Dims, n: number, total: number) {
  // Writing inside the bottom margin would trigger PDFKit's own page break;
  // lift the margin for the duration of the stamp.
  const prevBottom = doc.page.margins.bottom
  doc.page.margins.bottom = 0
  doc.save()
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#666')
    .text(`${n} / ${total}`, d.margin, d.fixedH! - d.margin + 8, {
      width: d.innerW,
      align: 'center',
      lineBreak: false,
    })
  doc.restore()
  doc.fillColor('#000')
  doc.page.margins.bottom = prevBottom
}

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
 * Renders a document. On roll paper the layout runs twice: once on an
 * oversized probe page to measure the content, then on a single page exactly
 * that tall. Fixed sizes (A4/A5/Letter) paginate instead: layouts call
 * ensureRoom() before each measured block, and per-page chrome (watermark,
 * CANCELLED stamp, page numbers) is applied to every page.
 */
async function render(
  s: AppSettings,
  paper: PaperSize,
  cancelled: boolean,
  layout: (doc: PDFKit.PDFDocument, d: Dims) => void,
): Promise<Buffer> {
  const d = dimsFor(paper)
  const opts = (height: number) => ({
    size: [d.pageW, height] as [number, number],
    margins: { top: d.margin, bottom: d.margin, left: d.margin, right: d.margin },
    bufferPages: true,
  })

  let pageH = d.fixedH
  if (pageH === null) {
    // Tall enough that a maximal order (100 items with notes) never overflows
    // the probe — an overflow would silently truncate the real page.
    const probe = new PDFDocument(opts(10000))
    probe.on('data', () => {})
    layout(probe, d)
    pageH = Math.max(probe.y + d.margin * 2, 40 * MM)
    probe.end()
  }

  const doc = new PDFDocument(opts(pageH))
  const done = collect(doc)
  // The watermark must sit behind the content: first page now, every later
  // page the moment it is added (before anything is drawn on it).
  drawBackground(doc, s, d.pageW, pageH)
  doc.on('pageAdded', () => drawBackground(doc, s, d.pageW, pageH))
  layout(doc, d)

  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    if (cancelled) drawCancelledStamp(doc, s.pdfLang, d.pageW, pageH)
    if (d.fixedH !== null && range.count > 1) {
      drawPageNumber(doc, d, i - range.start + 1, range.count)
    }
  }
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

/** Cancelled lines are omitted from every printed document. */
function activeItems(items: OrderItem[]): OrderItem[] {
  return items.filter((i) => i.cancelledAt === null)
}

function dashes(doc: PDFKit.PDFDocument, d: Dims) {
  ensureRoom(doc, d, 16)
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
  allItems: OrderItem[],
  s: AppSettings,
): Promise<Buffer> {
  const L = LABELS[s.pdfLang]
  const items = activeItems(allItems)
  return render(s, s.kitchenPaperSize, order.cancelledAt !== null, (doc, d) => {
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
      const label = `${item.qty} × ${item.nameSnapshot}`
      doc.font('Helvetica-Bold').fontSize(15)
      let h = doc.heightOfString(label, { width: d.innerW })
      if (item.note) {
        doc.font('Helvetica-Oblique').fontSize(11)
        h += doc.heightOfString(`   » ${item.note}`, { width: d.innerW })
      }
      ensureRoom(doc, d, h)
      doc.font('Helvetica-Bold').fontSize(15).text(label)
      if (item.note) {
        doc.font('Helvetica-Oblique').fontSize(11).text(`   » ${item.note}`)
      }
      doc.moveDown(0.25)
    }

    if (order.note) {
      dashes(doc, d)
      doc.font('Helvetica-Oblique').fontSize(12)
      ensureRoom(doc, d, doc.heightOfString(order.note, { width: d.innerW }))
      doc.text(order.note)
    }
  })
}

/** Customer receipt: itemised with prices, coperto and the total. */
export function renderReceipt(
  order: Order,
  allItems: OrderItem[],
  s: AppSettings,
): Promise<Buffer> {
  const L = LABELS[s.pdfLang]
  const lang = s.pdfLang
  const items = activeItems(allItems)
  return render(s, s.paperSize, order.cancelledAt !== null, (doc, d) => {
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
      // Measure first: the row must land on one page as a unit, or the price
      // (drawn at the captured y) ends up stranded on the wrong page.
      doc.font(opts?.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(11)
      let h = Math.max(
        doc.heightOfString(label, { width: d.innerW - priceW }),
        doc.heightOfString('0', { width: priceW }),
      )
      if (opts?.note) {
        doc.font('Helvetica-Oblique').fontSize(9)
        h += doc.heightOfString(`   ${opts.note}`, { width: d.innerW - priceW })
      }
      ensureRoom(doc, d, h)
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

    ensureRoom(doc, d, 20)
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
export function renderOrderSheet(
  order: Order,
  allItems: OrderItem[],
  s: AppSettings,
): Promise<Buffer> {
  const L = LABELS[s.pdfLang]
  const lang = s.pdfLang
  const items = activeItems(allItems)
  return render(s, s.orderPaperSize, order.cancelledAt !== null, (doc, d) => {
    // Centered image scaled to a % of the printable width, height proportional.
    const scaledImage = (dataUrl: string, pct: number) => {
      const img = imageBuffer(dataUrl)
      if (!img) return
      const w = (d.innerW * pct) / 100
      const dims = imageDims(img)
      const h = dims ? (w * dims.h) / dims.w : (s.orderPaperSize === 'roll80' ? 16 * MM : 24 * MM)
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

    // ---- coperto first, set apart from the products by the same thin
    // separator used between category groups (issue #27) ----
    if (order.covers > 0 && order.coverChargeCents > 0) {
      ensureRoom(doc, d, lineHeight(`${order.covers} × ${L.coverCharge}`) + 8)
      line(`${order.covers} × ${L.coverCharge}`, order.covers * order.coverChargeCents)
      doc.y += 2
      doc
        .moveTo(d.margin, doc.y + 1)
        .lineTo(d.margin + d.innerW, doc.y + 1)
        .strokeColor('#999')
        .stroke()
      doc.y += 5
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
        ensureRoom(doc, d, 8)
        doc
          .moveTo(d.margin, doc.y + 1)
          .lineTo(d.margin + d.innerW, doc.y + 1)
          .strokeColor('#999')
          .stroke()
        doc.y += 5
      }

      const shaded = s.orderCategoryStyle === 'alternating' && i % 2 === 1
      doc.font('Helvetica-Bold').fontSize(8)
      const headerH = doc.heightOfString(g.name.toUpperCase(), { width: nameW - PAD * 2 }) + 2
      const rowHs = g.items.map((item) =>
        lineHeight(`${item.qty} × ${item.nameSnapshot}`, item.note ?? undefined),
      )

      // Never leave the category header orphaned at the bottom of a page.
      ensureRoom(doc, d, headerH + rowHs[0]!)

      // The shading is painted per unit (header or row) rather than as one
      // block rect, so a group split across pages stays shaded on both sides
      // of the break. Adjacent same-color rects merge seamlessly, keeping the
      // unsplit case pixel-identical to the old single rect.
      const shade = (h: number) => {
        if (!shaded) return
        doc.rect(d.margin, doc.y - PAD / 2, d.innerW, h + PAD).fill('#f0f0f0')
        doc.fillColor('#000')
      }

      shade(headerH)
      doc
        .fillColor('#555')
        .font('Helvetica-Bold')
        .fontSize(8)
        .text(g.name.toUpperCase(), d.margin + PAD, doc.y, { width: nameW - PAD * 2 })
      doc.fillColor('#000')
      doc.y += 2
      g.items.forEach((item, j) => {
        ensureRoom(doc, d, rowHs[j]!)
        shade(rowHs[j]!)
        line(`${item.qty} × ${item.nameSnapshot}`, item.priceCentsSnapshot * item.qty, item.note ?? undefined)
      })
      doc.y += PAD
    })

    // ---- total, highlighted ----
    doc.y += 2
    const totalH = 24
    ensureRoom(doc, d, totalH + 6)
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
      doc.font('Helvetica-Oblique').fontSize(11)
      ensureRoom(doc, d, doc.heightOfString(`${L.note}: ${order.note}`, { width: d.innerW }))
      doc.text(`${L.note}: ${order.note}`, d.margin, doc.y, { width: d.innerW })
      doc.moveDown(0.3)
    }

    // ---- disclaimer + footer ----
    // On fixed page sizes these are pinned to the bottom of the page, no
    // matter how short the order is (issue #26). Roll paper keeps flowing:
    // its page height hugs the content and blank space is wasted paper.
    const GAP = 8
    const footerImg = s.orderFooterImage ? imageBuffer(s.orderFooterImage) : null
    let footerImgH = 0
    if (footerImg) {
      const w = (d.innerW * s.orderFooterImageWidthPct) / 100
      const dims = imageDims(footerImg)
      footerImgH = dims ? (w * dims.h) / dims.w : 16 * MM
    }
    let bottomH = 0
    if (s.orderDisclaimer) {
      doc.font('Helvetica-Bold').fontSize(s.orderDisclaimerFontSize)
      bottomH += doc.heightOfString(s.orderDisclaimer, { width: d.innerW }) + GAP
    }
    if (s.orderFooterText) {
      doc.font('Helvetica').fontSize(s.orderFooterFontSize)
      bottomH += doc.heightOfString(s.orderFooterText, { width: d.innerW }) + GAP
    }
    if (footerImg) bottomH += footerImgH + GAP

    if (bottomH > 0) {
      doc.y += GAP
      if (d.fixedH !== null) {
        // No room left under the order? The whole footer moves to a fresh
        // page rather than being torn across the break.
        ensureRoom(doc, d, bottomH)
        const pinnedTop = d.fixedH - d.margin - bottomH
        // Pin to the bottom of the (now last) page when there is room.
        if (pinnedTop > doc.y) doc.y = pinnedTop
      }
      if (s.orderDisclaimer) {
        doc
          .font('Helvetica-Bold')
          .fontSize(s.orderDisclaimerFontSize)
          .fillColor('#555')
          .text(s.orderDisclaimer, d.margin, doc.y, { width: d.innerW, align: 'center' })
        doc.fillColor('#000')
        doc.y += GAP
      }
      if (s.orderFooterText) {
        doc
          .font('Helvetica')
          .fontSize(s.orderFooterFontSize)
          .fillColor('#444')
          .text(s.orderFooterText, d.margin, doc.y, { width: d.innerW, align: 'center' })
        doc.fillColor('#000')
        doc.y += GAP
      }
      if (footerImg) {
        const w = (d.innerW * s.orderFooterImageWidthPct) / 100
        try {
          doc.image(footerImg, d.margin + (d.innerW - w) / 2, doc.y, { width: w })
          doc.y += footerImgH
        } catch {
          // ignore bad image data
        }
      }
    }
  })
}
