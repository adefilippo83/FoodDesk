import { and, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import PDFDocument from 'pdfkit'
import type { FastifyInstance } from 'fastify'
import { requireManager } from '../auth/acl.js'
import type { Db } from '../db/index.js'
import { orderItems, orders, users } from '../db/schema.js'
import { isServiceDay, serviceDayOf } from '../lib/serviceDay.js'
import { loadSettings } from '../settings.js'

/**
 * Reconciliation numbers come from order/item snapshots, not the live menu —
 * a past day's report must not change when the menu or the coperto does.
 * Cancelled orders are excluded from every total but stay in the CSV,
 * flagged: the person doing the books should see everything.
 */

type OrderRow = {
  id: number
  dailyNumber: number
  createdAt: number
  customerName: string | null
  covers: number
  coverChargeCents: number
  totalCents: number
  cancelledAt: number | null
  paymentMethod: 'cash' | 'stripe' | 'paypal' | null
  refundedAt: number | null
  waiter: string | null
}

type ItemRow = {
  orderId: number
  category: string
  item: string
  qty: number
  unitCents: number
  cancelledAt: number | null
}

async function loadDay(db: Db, day: string): Promise<{ orders: OrderRow[]; items: ItemRow[] }> {
  const orderRows = await db
    .select({
      id: orders.id,
      dailyNumber: orders.dailyNumber,
      createdAt: orders.createdAt,
      customerName: orders.customerName,
      covers: orders.covers,
      coverChargeCents: orders.coverChargeCents,
      totalCents: orders.totalCents,
      cancelledAt: orders.cancelledAt,
      paymentMethod: orders.paymentMethod,
      refundedAt: orders.refundedAt,
      waiter: users.displayName,
    })
    .from(orders)
    // LEFT join: customer self-orders have no author and must still count.
    .leftJoin(users, eq(users.id, orders.createdBy))
    .where(
      and(
        eq(orders.serviceDay, day),
        // Held online-payment orders are not money (yet): out of the books.
        or(isNull(orders.paymentRef), isNotNull(orders.paidAt), isNotNull(orders.cancelledAt)),
      ),
    )
    .orderBy(orders.dailyNumber)

  const itemRows = orderRows.length
    ? await db
        .select({
          orderId: orderItems.orderId,
          category: orderItems.categoryNameSnapshot,
          item: orderItems.nameSnapshot,
          qty: orderItems.qty,
          unitCents: orderItems.priceCentsSnapshot,
          cancelledAt: orderItems.cancelledAt,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(
      and(
        eq(orders.serviceDay, day),
        // Held online-payment orders are not money (yet): out of the books.
        or(isNull(orders.paymentRef), isNotNull(orders.paidAt), isNotNull(orders.cancelledAt)),
      ),
    )
    : []

  return { orders: orderRows, items: itemRows }
}

type Tally = { name: string; qty: number; revenueCents: number }

function buildReport(day: string, data: { orders: OrderRow[]; items: ItemRow[] }) {
  const active = data.orders.filter((o) => !o.cancelledAt)
  const activeIds = new Set(active.map((o) => o.id))
  // Line-cancelled items earn nothing, exactly like cancelled orders.
  const activeItems = data.items.filter((i) => activeIds.has(i.orderId) && !i.cancelledAt)

  const revenueCents = active.reduce((s, o) => s + o.totalCents, 0)
  const totalCovers = active.reduce((s, o) => s + o.covers, 0)
  const coverRevenueCents = active.reduce((s, o) => s + o.covers * o.coverChargeCents, 0)

  const tally = (key: (r: ItemRow) => string): Tally[] => {
    const map = new Map<string, { qty: number; revenueCents: number }>()
    for (const r of activeItems) {
      const k = key(r)
      const e = map.get(k) ?? { qty: 0, revenueCents: 0 }
      e.qty += r.qty
      e.revenueCents += r.qty * r.unitCents
      map.set(k, e)
    }
    return [...map.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.revenueCents - a.revenueCents)
  }

  const byCategory = tally((r) => r.category)
  // Coperto earns real money; the category table should account for it so
  // its lines sum to the day's revenue.
  if (coverRevenueCents > 0) {
    byCategory.push({ name: 'Coperto', qty: totalCovers, revenueCents: coverRevenueCents })
    byCategory.sort((a, b) => b.revenueCents - a.revenueCents)
  }

  // Where the money physically is: the cash drawer vs the two provider
  // dashboards. Staff orders and counter-paid self-orders are both drawer.
  const payKey = (o: OrderRow) =>
    o.paymentMethod === 'stripe' || o.paymentMethod === 'paypal' ? o.paymentMethod : 'counter'
  const payMap = new Map<string, { ordersCount: number; revenueCents: number }>()
  for (const o of active) {
    const e = payMap.get(payKey(o)) ?? { ordersCount: 0, revenueCents: 0 }
    e.ordersCount += 1
    e.revenueCents += o.totalCents
    payMap.set(payKey(o), e)
  }
  const byPayment = [...payMap.entries()]
    .map(([method, v]) => ({ method, ...v }))
    .sort((a, b) => b.revenueCents - a.revenueCents)

  // Refunds live on cancelled orders; they are outside revenue but the
  // person doing the books must see money that went back out.
  const refunded = data.orders.filter((o) => o.cancelledAt && o.refundedAt)
  const refundedCents = refunded.reduce((s, o) => s + o.totalCents, 0)

  return {
    serviceDay: day,
    ordersCount: active.length,
    cancelledCount: data.orders.length - active.length,
    revenueCents,
    totalCovers,
    coverRevenueCents,
    // Average spend per person; meaningless without covers, so null then.
    avgPerCoverCents: totalCovers > 0 ? Math.round(revenueCents / totalCovers) : null,
    byProduct: tally((r) => `${r.item} (${r.category})`),
    byCategory,
    byPayment,
    refundedCount: refunded.length,
    refundedCents,
  }
}

/**
 * Semicolon-separated with decimal-comma money: what Excel/LibreOffice in an
 * Italian (or any comma-decimal) locale opens correctly without an import
 * wizard. Coperto appears as its own line per order so the line totals sum
 * to the day's revenue.
 */
function toCsv(data: { orders: OrderRow[]; items: ItemRow[] }): string {
  const esc = (v: string | number | null): string => {
    const s = v === null ? '' : String(v)
    return /[;"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  const money = (cents: number) => (cents / 100).toFixed(2).replace('.', ',')
  const byOrder = new Map<number, ItemRow[]>()
  for (const i of data.items) {
    const list = byOrder.get(i.orderId) ?? []
    list.push(i)
    byOrder.set(i.orderId, list)
  }

  const lines = [
    'order;time;customer;waiter;payment;category;item;qty;unit_price;line_total;cancelled;refunded',
  ]
  for (const o of data.orders) {
    const time = new Date(o.createdAt * 1000).toLocaleTimeString('it-IT', {
      hour: '2-digit',
      minute: '2-digit',
    })
    const cancelled = o.cancelledAt ? 'yes' : ''
    const refunded = o.refundedAt ? 'yes' : ''
    const payment =
      o.paymentMethod === 'stripe' || o.paymentMethod === 'paypal' ? o.paymentMethod : 'counter'
    const base = [
      String(o.dailyNumber).padStart(3, '0'),
      time,
      esc(o.customerName),
      esc(o.waiter),
      payment,
    ]
    for (const i of byOrder.get(o.id) ?? []) {
      const lineCancelled = o.cancelledAt || i.cancelledAt ? 'yes' : ''
      lines.push(
        [...base, esc(i.category), esc(i.item), i.qty, money(i.unitCents), money(i.qty * i.unitCents), lineCancelled, refunded].join(';'),
      )
    }
    if (o.covers > 0 && o.coverChargeCents > 0) {
      lines.push(
        [...base, 'Coperto', 'Coperto', o.covers, money(o.coverChargeCents), money(o.covers * o.coverChargeCents), cancelled, refunded].join(';'),
      )
    }
  }
  return lines.join('\r\n') + '\r\n'
}

/** A4 one-pager of the dashboard: stats up top, breakdown tables below. */
async function renderReportPdf(
  report: ReturnType<typeof buildReport>,
  restaurantName: string,
): Promise<Buffer> {
  const MM = 72 / 25.4
  const margin = 18 * MM
  const doc = new PDFDocument({ size: 'A4', margins: { top: margin, bottom: margin, left: margin, right: margin } })
  const done = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
  const pageW = 595.28
  const innerW = pageW - margin * 2
  const money = (cents: number) => `€ ${(cents / 100).toFixed(2).replace('.', ',')}`

  doc.font('Helvetica-Bold').fontSize(20).text(restaurantName)
  doc.font('Helvetica').fontSize(12).fillColor('#555').text(`Report · ${report.serviceDay}`)
  doc.fillColor('#000').moveDown(1)

  const stats: Array<[string, string]> = [
    ['Ordini', String(report.ordersCount)],
    ['Incasso', money(report.revenueCents)],
    ['Coperti', String(report.totalCovers)],
  ]
  if (report.avgPerCoverCents !== null) {
    stats.push(['Medio a coperto', money(report.avgPerCoverCents)])
  }
  if (report.cancelledCount > 0) stats.push(['Annullati', String(report.cancelledCount)])
  if (report.refundedCount > 0) stats.push(['Rimborsati', money(report.refundedCents)])

  const statW = innerW / stats.length
  const statY = doc.y
  stats.forEach(([label, value], i) => {
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(label, margin + i * statW, statY, { width: statW })
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#000').text(value, margin + i * statW, statY + 12, { width: statW })
  })
  doc.x = margin
  doc.y = statY + 40

  const table = (title: string, rows: Tally[]) => {
    // Reset the cursor: the previous table leaves doc.x at its last column.
    doc.x = margin
    doc.moveDown(1)
    doc.font('Helvetica-Bold').fontSize(13).text(title, margin, doc.y, { width: innerW })
    doc.moveDown(0.3)
    const colQty = margin + innerW - 140
    const colRev = margin + innerW - 70
    const header = doc.y
    doc.font('Helvetica').fontSize(9).fillColor('#555')
    doc.text('Nome', margin, header, { width: colQty - margin - 8 })
    doc.text('Q.tà', colQty, header, { width: 60, align: 'right' })
    doc.text('Incasso', colRev, header, { width: 70, align: 'right' })
    doc.fillColor('#000')
    doc.moveTo(margin, doc.y + 2).lineTo(margin + innerW, doc.y + 2).strokeColor('#999').stroke()
    doc.y += 6
    for (const r of rows) {
      const y = doc.y
      doc.font('Helvetica').fontSize(10)
      doc.text(r.name, margin, y, { width: colQty - margin - 8 })
      const bottom = doc.y
      doc.text(String(r.qty), colQty, y, { width: 60, align: 'right' })
      doc.text(money(r.revenueCents), colRev, y, { width: 70, align: 'right' })
      doc.y = Math.max(doc.y, bottom) + 2
      doc.x = margin
    }
  }

  const PAY_LABELS: Record<string, string> = { counter: 'Cassa', stripe: 'Stripe', paypal: 'PayPal' }
  table(
    'Per pagamento',
    report.byPayment.map((p) => ({
      name: PAY_LABELS[p.method] ?? p.method,
      qty: p.ordersCount,
      revenueCents: p.revenueCents,
    })),
  )
  table('Per prodotto', report.byProduct)
  table('Per categoria', report.byCategory)

  doc.end()
  return done
}

export function reportRoutes(db: Db) {
  return async function register(app: FastifyInstance) {
    // The maître d' reconciles the day just like an admin.
    app.addHook('preHandler', requireManager)

    /** Every service day that has orders — feeds the day picker. */
    app.get('/api/reports/days', async () => {
      return db
        .select({
          serviceDay: orders.serviceDay,
          ordersCount: sql<number>`count(*)`,
          revenueCents: sql<number>`coalesce(sum(${orders.totalCents}), 0)`,
        })
        .from(orders)
        .where(
          and(
            isNull(orders.cancelledAt),
            or(isNull(orders.paymentRef), isNotNull(orders.paidAt)),
          ),
        )
        .groupBy(orders.serviceDay)
        .orderBy(desc(orders.serviceDay))
    })

    const dayParam = (req: { query: unknown }): string | null => {
      const day = (req.query as { day?: string }).day ?? serviceDayOf()
      return isServiceDay(day) ? day : null
    }

    app.get('/api/reports/daily', async (req, reply) => {
      const day = dayParam(req)
      if (!day) return reply.code(400).send({ error: 'invalid_day' })
      return buildReport(day, await loadDay(db, day))
    })

    app.get('/api/reports/daily.csv', async (req, reply) => {
      const day = dayParam(req)
      if (!day) return reply.code(400).send({ error: 'invalid_day' })
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="fooddesk-${day}.csv"`)
        .send(toCsv(await loadDay(db, day)))
    })

    app.get('/api/reports/daily.pdf', async (req, reply) => {
      const day = dayParam(req)
      if (!day) return reply.code(400).send({ error: 'invalid_day' })
      const [report, settings] = await Promise.all([
        loadDay(db, day).then((d) => buildReport(day, d)),
        loadSettings(db),
      ])
      const pdf = await renderReportPdf(report, settings.restaurantName)
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="fooddesk-report-${day}.pdf"`)
        .send(pdf)
    })
  }
}
