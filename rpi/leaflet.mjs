// Generates the printable venue leaflet: an A4 page with the Wi-Fi QR code
// and the FoodDesk address, meant to be printed and taped up at the venue.
// No credentials beyond the Wi-Fi password appear on it — the admin password
// stays in fooddesk-info.txt.
//
// Run on the Pi by rpi/provision.sh:
//   node /opt/fooddesk/rpi/leaflet.mjs --ssid X --password Y --out leaflet.pdf
// (resolves pdfkit and qrcode from /opt/fooddesk/node_modules)
import { createWriteStream } from 'node:fs'
import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const ssid = arg('ssid')
const password = arg('password')
const out = arg('out')
if (!ssid || !password || !out) {
  console.error('usage: leaflet.mjs --ssid <ssid> --password <pass> --out <file.pdf>')
  process.exit(1)
}

// WIFI: QR payload — backslash-escape the four special characters.
const esc = (s) => s.replace(/([\\;,:"])/g, '\\$1')
const wifiPayload = `WIFI:T:WPA;S:${esc(ssid)};P:${esc(password)};;`
const URL = 'http://10.42.0.1/'

const wifiQr = await QRCode.toBuffer(wifiPayload, { width: 480, margin: 1 })
const urlQr = await QRCode.toBuffer(URL, { width: 480, margin: 1 })
const orderQr = await QRCode.toBuffer(`${URL}order`, { width: 480, margin: 1 })

const A4 = [595.28, 841.89]
const doc = new PDFDocument({ size: A4, margins: { top: 60, bottom: 60, left: 60, right: 60 } })
const done = new Promise((resolve, reject) => {
  const stream = createWriteStream(out)
  doc.pipe(stream)
  stream.on('finish', resolve)
  stream.on('error', reject)
})

const W = A4[0]
const inner = W - 120

doc.font('Helvetica-Bold').fontSize(34).text('FoodDesk', { align: 'center' })
doc.moveDown(0.2)
doc
  .font('Helvetica')
  .fontSize(14)
  .fillColor('#444')
  .text('Comande dal telefono · Orders from your phone', { align: 'center' })
doc.fillColor('#000')

const section = (n, it, en, qr, caption) => {
  doc.moveDown(0.9)
  doc.font('Helvetica-Bold').fontSize(17).text(`${n}. ${it}`, { align: 'center' })
  doc.font('Helvetica').fontSize(12).fillColor('#444').text(en, { align: 'center' })
  doc.fillColor('#000')
  doc.moveDown(0.5)
  const size = 120
  doc.image(qr, (W - size) / 2, doc.y, { width: size })
  doc.y += size + 8
  doc.font('Helvetica-Bold').fontSize(13).text(caption, 60, doc.y, { width: inner, align: 'center' })
}

section(
  1,
  'Collegati al Wi-Fi',
  'Join the Wi-Fi network',
  wifiQr,
  `${ssid}  ·  password: ${password}`,
)
// Customers first: they only ever need /order. Staff open the app root.
section(2, 'Ordina dal tuo telefono', 'Order from your phone', orderQr, `${URL}order`)
section(3, 'Staff: apri FoodDesk', 'Staff: open FoodDesk', urlQr, URL)

doc.moveDown(0.8)
doc
  .font('Helvetica')
  .fontSize(10)
  .fillColor('#666')
  .text(
    'Inquadra i codici QR con la fotocamera del telefono. · Scan the QR codes with your phone camera.',
    { align: 'center' },
  )

doc.end()
await done
console.log(`leaflet written: ${out}`)
