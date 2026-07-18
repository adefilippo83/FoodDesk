import { desc, eq, sql } from 'drizzle-orm';
import { requireAdmin } from '../auth/acl.js';
import { orderItems, orders, users } from '../db/schema.js';
import { isServiceDay, serviceDayOf } from '../lib/serviceDay.js';
async function loadDay(db, day) {
    return db
        .select({
        dailyNumber: orders.dailyNumber,
        createdAt: orders.createdAt,
        tableLabel: orders.tableLabel,
        waiter: users.displayName,
        category: orderItems.categoryNameSnapshot,
        item: orderItems.nameSnapshot,
        qty: orderItems.qty,
        unitCents: orderItems.priceCentsSnapshot,
    })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .innerJoin(users, eq(users.id, orders.createdBy))
        .where(eq(orders.serviceDay, day))
        .orderBy(orders.dailyNumber);
}
function tally(rows, key) {
    const out = new Map();
    for (const r of rows) {
        const k = key(r);
        const entry = out.get(k) ?? { qty: 0, revenueCents: 0 };
        entry.qty += r.qty;
        entry.revenueCents += r.qty * r.unitCents;
        out.set(k, entry);
    }
    return out;
}
/**
 * Semicolon-separated with decimal-comma money: what Excel/LibreOffice in an
 * Italian (or any comma-decimal) locale opens correctly without an import
 * wizard. Plain enough that anything else copes too.
 */
function toCsv(rows) {
    const esc = (v) => {
        const s = v === null ? '' : String(v);
        return /[;"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const money = (cents) => (cents / 100).toFixed(2).replace('.', ',');
    const header = ['order', 'time', 'table', 'waiter', 'category', 'item', 'qty', 'unit_price', 'line_total'];
    const lines = [header.join(';')];
    for (const r of rows) {
        const time = new Date(r.createdAt * 1000).toLocaleTimeString('it-IT', {
            hour: '2-digit',
            minute: '2-digit',
        });
        lines.push([
            String(r.dailyNumber).padStart(3, '0'),
            time,
            esc(r.tableLabel),
            esc(r.waiter),
            esc(r.category),
            esc(r.item),
            r.qty,
            money(r.unitCents),
            money(r.qty * r.unitCents),
        ].join(';'));
    }
    return lines.join('\r\n') + '\r\n';
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
                revenueCents: sql `sum(${orders.totalCents})`,
            })
                .from(orders)
                .groupBy(orders.serviceDay)
                .orderBy(desc(orders.serviceDay));
        });
        app.get('/api/reports/daily', async (req, reply) => {
            const q = req.query;
            const day = q.day ?? serviceDayOf();
            if (!isServiceDay(day))
                return reply.code(400).send({ error: 'invalid_day' });
            const rows = await loadDay(db, day);
            const orderNumbers = new Set(rows.map((r) => r.dailyNumber));
            const revenueCents = rows.reduce((s, r) => s + r.qty * r.unitCents, 0);
            const byKey = (m) => [...m.entries()]
                .map(([name, v]) => ({ name, ...v }))
                .sort((a, b) => b.revenueCents - a.revenueCents);
            // Waiter revenue counts whole orders, not lines, so tally separately.
            const waiterOrders = new Map();
            for (const r of rows) {
                const set = waiterOrders.get(r.waiter) ?? new Set();
                set.add(r.dailyNumber);
                waiterOrders.set(r.waiter, set);
            }
            return {
                serviceDay: day,
                ordersCount: orderNumbers.size,
                revenueCents,
                avgOrderCents: orderNumbers.size ? Math.round(revenueCents / orderNumbers.size) : 0,
                byProduct: byKey(tally(rows, (r) => `${r.item} (${r.category})`)),
                byCategory: byKey(tally(rows, (r) => r.category)),
                byWaiter: [...tally(rows, (r) => r.waiter).entries()]
                    .map(([name, v]) => ({
                    name,
                    revenueCents: v.revenueCents,
                    ordersCount: waiterOrders.get(name)?.size ?? 0,
                }))
                    .sort((a, b) => b.revenueCents - a.revenueCents),
            };
        });
        app.get('/api/reports/daily.csv', async (req, reply) => {
            const q = req.query;
            const day = q.day ?? serviceDayOf();
            if (!isServiceDay(day))
                return reply.code(400).send({ error: 'invalid_day' });
            const rows = await loadDay(db, day);
            return reply
                .header('content-type', 'text/csv; charset=utf-8')
                .header('content-disposition', `attachment; filename="fooddesk-${day}.csv"`)
                .send(toCsv(rows));
        });
    };
}
