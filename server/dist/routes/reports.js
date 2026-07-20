import { desc, eq, isNull, sql } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import { requireAdmin } from '../auth/acl.js';
import { orderItems, orders, users } from '../db/schema.js';
import { isServiceDay, serviceDayOf } from '../lib/serviceDay.js';
import { loadSettings } from '../settings.js';
async function loadDay(db, day) {
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
        waiter: users.displayName,
    })
        .from(orders)
        .innerJoin(users, eq(users.id, orders.createdBy))
        .where(eq(orders.serviceDay, day))
        .orderBy(orders.dailyNumber);
    const itemRows = orderRows.length
        ? await db
            .select({
            orderId: orderItems.orderId,
            category: orderItems.categoryNameSnapshot,
            item: orderItems.nameSnapshot,
            qty: orderItems.qty,
            unitCents: orderItems.priceCentsSnapshot,
        })
            .from(orderItems)
            .innerJoin(orders, eq(orders.id, orderItems.orderId))
            .where(eq(orders.serviceDay, day))
        : [];
    return { orders: orderRows, items: itemRows };
}
function buildReport(day, data) {
    const active = data.orders.filter((o) => !o.cancelledAt);
    const activeIds = new Set(active.map((o) => o.id));
    const activeItems = data.items.filter((i) => activeIds.has(i.orderId));
    const revenueCents = active.reduce((s, o) => s + o.totalCents, 0);
    const totalCovers = active.reduce((s, o) => s + o.covers, 0);
    const coverRevenueCents = active.reduce((s, o) => s + o.covers * o.coverChargeCents, 0);
    const tally = (key) => {
        const map = new Map();
        for (const r of activeItems) {
            const k = key(r);
            const e = map.get(k) ?? { qty: 0, revenueCents: 0 };
            e.qty += r.qty;
            e.revenueCents += r.qty * r.unitCents;
            map.set(k, e);
        }
        return [...map.entries()]
            .map(([name, v]) => ({ name, ...v }))
            .sort((a, b) => b.revenueCents - a.revenueCents);
    };
    const byCategory = tally((r) => r.category);
    // Coperto earns real money; the category table should account for it so
    // its lines sum to the day's revenue.
    if (coverRevenueCents > 0) {
        byCategory.push({ name: 'Coperto', qty: totalCovers, revenueCents: coverRevenueCents });
        byCategory.sort((a, b) => b.revenueCents - a.revenueCents);
    }
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
    };
}
/**
 * Semicolon-separated with decimal-comma money: what Excel/LibreOffice in an
 * Italian (or any comma-decimal) locale opens correctly without an import
 * wizard. Coperto appears as its own line per order so the line totals sum
 * to the day's revenue.
 */
function toCsv(data) {
    const esc = (v) => {
        const s = v === null ? '' : String(v);
        return /[;"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const money = (cents) => (cents / 100).toFixed(2).replace('.', ',');
    const byOrder = new Map();
    for (const i of data.items) {
        const list = byOrder.get(i.orderId) ?? [];
        list.push(i);
        byOrder.set(i.orderId, list);
    }
    const lines = ['order;time;customer;waiter;category;item;qty;unit_price;line_total;cancelled'];
    for (const o of data.orders) {
        const time = new Date(o.createdAt * 1000).toLocaleTimeString('it-IT', {
            hour: '2-digit',
            minute: '2-digit',
        });
        const cancelled = o.cancelledAt ? 'yes' : '';
        const base = [String(o.dailyNumber).padStart(3, '0'), time, esc(o.customerName), esc(o.waiter)];
        for (const i of byOrder.get(o.id) ?? []) {
            lines.push([...base, esc(i.category), esc(i.item), i.qty, money(i.unitCents), money(i.qty * i.unitCents), cancelled].join(';'));
        }
        if (o.covers > 0 && o.coverChargeCents > 0) {
            lines.push([...base, 'Coperto', 'Coperto', o.covers, money(o.coverChargeCents), money(o.covers * o.coverChargeCents), cancelled].join(';'));
        }
    }
    return lines.join('\r\n') + '\r\n';
}
/** A4 one-pager of the dashboard: stats up top, breakdown tables below. */
async function renderReportPdf(report, restaurantName) {
    const MM = 72 / 25.4;
    const margin = 18 * MM;
    const doc = new PDFDocument({ size: 'A4', margins: { top: margin, bottom: margin, left: margin, right: margin } });
    const done = new Promise((resolve, reject) => {
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
    });
    const pageW = 595.28;
    const innerW = pageW - margin * 2;
    const money = (cents) => `€ ${(cents / 100).toFixed(2).replace('.', ',')}`;
    doc.font('Helvetica-Bold').fontSize(20).text(restaurantName);
    doc.font('Helvetica').fontSize(12).fillColor('#555').text(`Report · ${report.serviceDay}`);
    doc.fillColor('#000').moveDown(1);
    const stats = [
        ['Ordini', String(report.ordersCount)],
        ['Incasso', money(report.revenueCents)],
        ['Coperti', String(report.totalCovers)],
    ];
    if (report.avgPerCoverCents !== null) {
        stats.push(['Medio a coperto', money(report.avgPerCoverCents)]);
    }
    if (report.cancelledCount > 0)
        stats.push(['Annullati', String(report.cancelledCount)]);
    const statW = innerW / stats.length;
    const statY = doc.y;
    stats.forEach(([label, value], i) => {
        doc.font('Helvetica').fontSize(9).fillColor('#555').text(label, margin + i * statW, statY, { width: statW });
        doc.font('Helvetica-Bold').fontSize(16).fillColor('#000').text(value, margin + i * statW, statY + 12, { width: statW });
    });
    doc.x = margin;
    doc.y = statY + 40;
    const table = (title, rows) => {
        // Reset the cursor: the previous table leaves doc.x at its last column.
        doc.x = margin;
        doc.moveDown(1);
        doc.font('Helvetica-Bold').fontSize(13).text(title, margin, doc.y, { width: innerW });
        doc.moveDown(0.3);
        const colQty = margin + innerW - 140;
        const colRev = margin + innerW - 70;
        const header = doc.y;
        doc.font('Helvetica').fontSize(9).fillColor('#555');
        doc.text('Nome', margin, header, { width: colQty - margin - 8 });
        doc.text('Q.tà', colQty, header, { width: 60, align: 'right' });
        doc.text('Incasso', colRev, header, { width: 70, align: 'right' });
        doc.fillColor('#000');
        doc.moveTo(margin, doc.y + 2).lineTo(margin + innerW, doc.y + 2).strokeColor('#999').stroke();
        doc.y += 6;
        for (const r of rows) {
            const y = doc.y;
            doc.font('Helvetica').fontSize(10);
            doc.text(r.name, margin, y, { width: colQty - margin - 8 });
            const bottom = doc.y;
            doc.text(String(r.qty), colQty, y, { width: 60, align: 'right' });
            doc.text(money(r.revenueCents), colRev, y, { width: 70, align: 'right' });
            doc.y = Math.max(doc.y, bottom) + 2;
            doc.x = margin;
        }
    };
    table('Per prodotto', report.byProduct);
    table('Per categoria', report.byCategory);
    doc.end();
    return done;
}
export function reportRoutes(db) {
    return async function register(app) {
        app.addHook('preHandler', requireAdmin);
        /** Every service day that has orders — feeds the day picker. */
        app.get('/api/reports/days', async () => {
            return db
                .select({
                serviceDay: orders.serviceDay,
                ordersCount: sql `count(*)`,
                revenueCents: sql `coalesce(sum(${orders.totalCents}), 0)`,
            })
                .from(orders)
                .where(isNull(orders.cancelledAt))
                .groupBy(orders.serviceDay)
                .orderBy(desc(orders.serviceDay));
        });
        const dayParam = (req) => {
            const day = req.query.day ?? serviceDayOf();
            return isServiceDay(day) ? day : null;
        };
        app.get('/api/reports/daily', async (req, reply) => {
            const day = dayParam(req);
            if (!day)
                return reply.code(400).send({ error: 'invalid_day' });
            return buildReport(day, await loadDay(db, day));
        });
        app.get('/api/reports/daily.csv', async (req, reply) => {
            const day = dayParam(req);
            if (!day)
                return reply.code(400).send({ error: 'invalid_day' });
            return reply
                .header('content-type', 'text/csv; charset=utf-8')
                .header('content-disposition', `attachment; filename="fooddesk-${day}.csv"`)
                .send(toCsv(await loadDay(db, day)));
        });
        app.get('/api/reports/daily.pdf', async (req, reply) => {
            const day = dayParam(req);
            if (!day)
                return reply.code(400).send({ error: 'invalid_day' });
            const [report, settings] = await Promise.all([
                loadDay(db, day).then((d) => buildReport(day, d)),
                loadSettings(db),
            ]);
            const pdf = await renderReportPdf(report, settings.restaurantName);
            return reply
                .header('content-type', 'application/pdf')
                .header('content-disposition', `attachment; filename="fooddesk-report-${day}.pdf"`)
                .send(pdf);
        });
    };
}
