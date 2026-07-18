import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { requireAuth } from '../auth/acl.js';
import { categories, orderItems, orders, products, users } from '../db/schema.js';
import { isServiceDay, serviceDayOf } from '../lib/serviceDay.js';
import { renderKitchenTicket, renderReceipt } from '../print/pdf.js';
import { kitchenQueue, printKitchenTicket } from '../print/service.js';
function parseItems(raw) {
    if (!Array.isArray(raw) || raw.length === 0)
        return { error: 'items_required' };
    if (raw.length > 100)
        return { error: 'too_many_items' };
    const items = [];
    for (const entry of raw) {
        const e = entry;
        const productId = Number(e?.productId);
        const qty = Number(e?.qty);
        if (!Number.isInteger(productId) || productId <= 0)
            return { error: 'invalid_product_id' };
        if (!Number.isInteger(qty) || qty <= 0 || qty > 99)
            return { error: 'invalid_qty' };
        const note = typeof e?.note === 'string' && e.note.trim() ? e.note.trim().slice(0, 200) : undefined;
        items.push({ productId, qty, note });
    }
    return items;
}
export function orderRoutes(db) {
    return async function register(app) {
        app.addHook('preHandler', requireAuth);
        /** Both roles may take orders — that is the operator's whole job. */
        app.post('/api/orders', async (req, reply) => {
            const body = req.body;
            const parsed = parseItems(body?.items);
            if ('error' in parsed)
                return reply.code(400).send({ error: parsed.error });
            const tableLabel = typeof body?.tableLabel === 'string' && body.tableLabel.trim()
                ? body.tableLabel.trim().slice(0, 40)
                : null;
            const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
            // Prices come from the database, never from the client. A tampered
            // payload cannot discount anything.
            const ids = [...new Set(parsed.map((i) => i.productId))];
            const rows = await db
                .select({
                id: products.id,
                name: products.name,
                priceCents: products.priceCents,
                active: products.active,
                categoryName: categories.name,
            })
                .from(products)
                .innerJoin(categories, eq(categories.id, products.categoryId))
                .where(inArray(products.id, ids));
            const byId = new Map(rows.map((r) => [r.id, r]));
            const missing = ids.filter((id) => !byId.has(id));
            if (missing.length)
                return reply.code(400).send({ error: 'unknown_products', missing });
            const inactive = ids.filter((id) => !byId.get(id).active);
            if (inactive.length) {
                return reply.code(409).send({ error: 'products_unavailable', unavailable: inactive });
            }
            const serviceDay = serviceDayOf();
            const userId = req.user.id;
            const created = db.transaction((tx) => {
                // Per-day sequence, allocated inside the transaction so two waiters
                // submitting at once cannot land on the same ticket number.
                const last = tx
                    .select({ max: sql `max(${orders.dailyNumber})` })
                    .from(orders)
                    .where(eq(orders.serviceDay, serviceDay))
                    .get();
                const dailyNumber = (last?.max ?? 0) + 1;
                const totalCents = parsed.reduce((sum, i) => sum + byId.get(i.productId).priceCents * i.qty, 0);
                const order = tx
                    .insert(orders)
                    .values({
                    dailyNumber,
                    serviceDay,
                    tableLabel,
                    note,
                    totalCents,
                    createdBy: userId,
                })
                    .returning()
                    .get();
                for (const item of parsed) {
                    const p = byId.get(item.productId);
                    tx.insert(orderItems)
                        .values({
                        orderId: order.id,
                        productId: p.id,
                        nameSnapshot: p.name,
                        priceCentsSnapshot: p.priceCents,
                        categoryNameSnapshot: p.categoryName,
                        qty: item.qty,
                        note: item.note ?? null,
                    })
                        .run();
                }
                return order;
            });
            const items = await db.select().from(orderItems).where(eq(orderItems.orderId, created.id));
            // Print in the background: the waiter gets their confirmation now, and a
            // slow or jammed printer shows up as printError on the order instead.
            printKitchenTicket(db, created).catch((err) => req.log.error(err, 'kitchen print crashed'));
            return reply.code(201).send({ ...created, items });
        });
        /** Loads an order enforcing the same visibility rule everywhere. */
        async function loadVisibleOrder(id, user) {
            const order = (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0];
            if (!order)
                return 'not_found';
            if (user.role !== 'admin' && order.createdBy !== user.id)
                return 'forbidden';
            return order;
        }
        for (const kind of ['receipt', 'kitchen']) {
            app.get(`/api/orders/:id/${kind}.pdf`, async (req, reply) => {
                const id = Number(req.params.id);
                const order = await loadVisibleOrder(id, req.user);
                if (order === 'not_found')
                    return reply.code(404).send({ error: 'not_found' });
                if (order === 'forbidden')
                    return reply.code(403).send({ error: 'forbidden' });
                const items = await db.select().from(orderItems).where(eq(orderItems.orderId, id));
                const pdf = kind === 'receipt'
                    ? await renderReceipt(order, items)
                    : await renderKitchenTicket(order, items);
                return reply
                    .header('content-type', 'application/pdf')
                    .header('content-disposition', `inline; filename="order-${order.serviceDay}-${String(order.dailyNumber).padStart(3, '0')}-${kind}.pdf"`)
                    .send(pdf);
            });
        }
        /** Re-send the kitchen ticket to CUPS — the jam-recovery button. */
        app.post('/api/orders/:id/print', async (req, reply) => {
            const id = Number(req.params.id);
            const order = await loadVisibleOrder(id, req.user);
            if (order === 'not_found')
                return reply.code(404).send({ error: 'not_found' });
            if (order === 'forbidden')
                return reply.code(403).send({ error: 'forbidden' });
            if (!kitchenQueue()) {
                return reply.code(409).send({ error: 'printer_not_configured' });
            }
            const result = await printKitchenTicket(db, order);
            if (!result.ok) {
                return reply.code(502).send({ error: result.error, detail: result.detail });
            }
            return { ok: true, printedAt: result.printedAt };
        });
        /** Admins see the whole service; operators see only what they rang up. */
        app.get('/api/orders', async (req) => {
            const q = req.query;
            const day = q.day && isServiceDay(q.day) ? q.day : serviceDayOf();
            const restrictToSelf = req.user.role !== 'admin' || q.mine === 'true';
            const where = restrictToSelf
                ? and(eq(orders.serviceDay, day), eq(orders.createdBy, req.user.id))
                : eq(orders.serviceDay, day);
            const rows = await db
                .select({
                id: orders.id,
                dailyNumber: orders.dailyNumber,
                serviceDay: orders.serviceDay,
                tableLabel: orders.tableLabel,
                note: orders.note,
                totalCents: orders.totalCents,
                createdAt: orders.createdAt,
                printedAt: orders.printedAt,
                printError: orders.printError,
                createdByName: users.displayName,
            })
                .from(orders)
                .innerJoin(users, eq(users.id, orders.createdBy))
                .where(where)
                .orderBy(desc(orders.dailyNumber));
            return { serviceDay: day, orders: rows };
        });
        app.get('/api/orders/:id', async (req, reply) => {
            const id = Number(req.params.id);
            const order = (await db.select().from(orders).where(eq(orders.id, id)).limit(1))[0];
            if (!order)
                return reply.code(404).send({ error: 'not_found' });
            // An operator must not be able to read a colleague's order by guessing ids.
            if (req.user.role !== 'admin' && order.createdBy !== req.user.id) {
                return reply.code(403).send({ error: 'forbidden' });
            }
            const items = await db.select().from(orderItems).where(eq(orderItems.orderId, id));
            return { ...order, items };
        });
    };
}
