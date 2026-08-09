import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import type { AppSettings } from '../settings.js'

/**
 * The printable way into customer self-ordering: an A4 poster for the wall
 * plus a page of four table cards to cut out. The QR encodes the venue's own
 * /order URL, derived from how the admin reached the server — the same
 * address works for the customers on the same network.
 */

const LABELS = {
  it: {
    title: 'Ordina dal tuo telefono',
    caption: "Inquadra il codice, scegli i piatti, invia l'ordine.",
  },
  en: {
    title: 'Order from your phone',
    caption: 'Scan the code, choose your dishes, send the order.',
  },
  es: {
    title: 'Pide desde tu móvil',
    caption: 'Escanea el código, elige tus platos, envía el pedido.',
  },
  fr: {
    title: 'Commandez depuis votre téléphone',
    caption: 'Scannez le code, choisissez vos plats, envoyez la commande.',
  },
  pt: {
    title: 'Peça pelo seu telemóvel',
    caption: 'Aponte a câmara para o código, escolha os pratos, envie o pedido.',
  },
}

const MM = 72 / 25.4
const PAGE_W = 595.28
const PAGE_H = 841.89

export async function renderCustomerQr(orderUrl: string, s: AppSettings): Promise<Buffer> {
  const L = LABELS[s.pdfLang]
  const qr = await QRCode.toBuffer(orderUrl, { width: 640, margin: 1 })

  const doc = new PDFDocument({ size: 'A4', margin: 18 * MM, autoFirstPage: false })
  const done = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  // ----- page 1: wall poster -----
  doc.addPage()
  doc.y = 40 * MM
  doc.font('Helvetica-Bold').fontSize(30).text(s.restaurantName, { align: 'center' })
  doc.moveDown(0.4)
  doc.font('Helvetica').fontSize(20).fillColor('#333').text(L.title, { align: 'center' })
  doc.fillColor('#000')

  const posterQr = 100 * MM
  doc.image(qr, (PAGE_W - posterQr) / 2, doc.y + 10 * MM, { width: posterQr })
  doc.y += posterQr + 16 * MM
  doc.font('Helvetica').fontSize(13).fillColor('#333').text(L.caption, { align: 'center' })
  doc.moveDown(0.6)
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#000').text(orderUrl, { align: 'center' })

  // ----- page 2: four table cards, 2×2 with dashed cut lines -----
  doc.addPage()
  const cutDash = () => {
    doc
      .save()
      .dash(3, { space: 3 })
      .strokeColor('#999')
      .moveTo(PAGE_W / 2, 0)
      .lineTo(PAGE_W / 2, PAGE_H)
      .stroke()
      .moveTo(0, PAGE_H / 2)
      .lineTo(PAGE_W, PAGE_H / 2)
      .stroke()
      .undash()
      .restore()
  }
  cutDash()

  const cardQr = 45 * MM
  for (const [cx, cy] of [
    [0, 0],
    [PAGE_W / 2, 0],
    [0, PAGE_H / 2],
    [PAGE_W / 2, PAGE_H / 2],
  ] as const) {
    const w = PAGE_W / 2
    let y = cy + 22 * MM
    doc.font('Helvetica-Bold').fontSize(15).text(s.restaurantName, cx, y, { width: w, align: 'center' })
    y = doc.y + 2 * MM
    doc.font('Helvetica').fontSize(11).fillColor('#333').text(L.title, cx, y, { width: w, align: 'center' })
    doc.fillColor('#000')
    y = doc.y + 5 * MM
    doc.image(qr, cx + (w - cardQr) / 2, y, { width: cardQr })
    y += cardQr + 5 * MM
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(orderUrl, cx, y, { width: w, align: 'center' })
    doc.fillColor('#000')
  }

  doc.end()
  return done
}
