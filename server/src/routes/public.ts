import { randomBytes } from 'node:crypto'
import { and, count, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/index.js'
import { categories, orderItems, orders, products } from '../db/schema.js'
import { notifyOrdersChanged } from '../lib/events.js'
import { parseItems, placeOrder } from '../lib/placeOrder.js'
import { serviceDayOf } from '../lib/serviceDay.js'
import { expireHeldOrder, isHeld, verifyHeldOrder } from '../payments/lifecycle.js'
import type { OnlineMethod, ProviderRegistry } from '../payments/provider.js'
import { printKitchenTicket } from '../print/service.js'
import { loadSettings } from '../settings.js'

/**
 * Customer self-ordering (phase A) + online payments (phase B): the only
 * unauthenticated surface of the app, deliberately narrow — read the menu,
 * place an order, follow your own order by unguessable token. Everything is
 * gated on the admin-controlled customerOrdering setting (default off) and
 * rate-limited per IP, since it listens on an open venue Wi-Fi.
 */

// How many customer orders may be open (not cancelled, unpaid) at once —
// the brake against an open-network flood. Configurable per venue; read
// lazily so a venue (or a test) can change it without a rebuild.
function orderCap(): number {
  const n = Number(process.env.CUSTOMER_ORDER_CAP)
  return Number.isInteger(n) && n > 0 ? n : 30
}

export function publicRoutes(db: Db, providers: ProviderRegistry) {
  return async function register(app: FastifyInstance) {
    /** 404 when the feature is off: the surface simply does not exist. */
    async function enabled(): Promise<boolean> {
      return (await loadSettings(db)).customerOrdering
    }

    app.get(
      '/api/public/menu',
      { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const s = await loadSettings(db)
        if (!s.customerOrdering) return reply.code(404).send({ error: 'not_found' })

        const rows = await db
          .select({
            categoryId: categories.id,
            categoryName: categories.name,
            categorySort: categories.sortOrder,
            productId: products.id,
            productName: products.name,
            priceCents: products.priceCents,
            productSort: products.sortOrder,
          })
          .from(products)
          .innerJoin(categories, eq(categories.id, products.categoryId))
          .where(and(eq(products.active, true), eq(categories.active, true)))

        rows.sort(
          (a, b) => a.categorySort - b.categorySort || a.productSort - b.productSort,
        )
        const menu: {
          id: number
          name: string
          products: { id: number; name: string; priceCents: number }[]
        }[] = []
        for (const r of rows) {
          let cat = menu.find((c) => c.id === r.categoryId)
          if (!cat) {
            cat = { id: r.categoryId, name: r.categoryName, products: [] }
            menu.push(cat)
          }
          cat.products.push({ id: r.productId, name: r.productName, priceCents: r.priceCents })
        }
        return {
          restaurantName: s.restaurantName,
          coverChargeCents: s.coverChargeCents,
          // "counter" is always available; online methods when configured.
          paymentMethods: ['counter', ...providers.keys()],
          menu,
        }
      },
    )

    app.post(
      '/api/public/orders',
      { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
      async (req, reply) => {
        if (!(await enabled())) return reply.code(404).send({ error: 'not_found' })

        const body = req.body as Record<string, unknown> | undefined
        const parsed = parseItems(body?.items)
        if ('error' in parsed) return reply.code(400).send({ error: parsed.error })

        const customerName =
          typeof body?.customerName === 'string' && body.customerName.trim()
            ? body.customerName.trim().slice(0, 60)
            : null
        if (!customerName) return reply.code(400).send({ error: 'customer_name_required' })

        // "How many people?" — minimum one; each person is one coperto.
        const covers = Number(body?.covers)
        if (!Number.isInteger(covers) || covers < 1 || covers > 99) {
          return reply.code(400).send({ error: 'invalid_covers' })
        }

        // counter (default) or a configured online provider.
        const payment = typeof body?.payment === 'string' ? body.payment : 'counter'
        const provider = payment === 'counter' ? null : providers.get(payment as OnlineMethod)
        if (payment !== 'counter' && !provider) {
          return reply.code(400).send({ error: 'payment_unavailable' })
        }

        const note =
          typeof body?.note === 'string' && body.note.trim()
            ? body.note.trim().slice(0, 500)
            : null
        const clientKey =
          typeof body?.clientKey === 'string' && body.clientKey.trim()
            ? body.clientKey.trim().slice(0, 64)
            : null

        // The flood brake: too many open customer orders means the kitchen
        // is drowning (or someone is playing games on the open Wi-Fi).
        const open = (
          await db
            .select({ n: count() })
            .from(orders)
            .where(
              and(
                eq(orders.serviceDay, serviceDayOf()),
                eq(orders.origin, 'customer'),
                isNull(orders.cancelledAt),
                isNull(orders.paidAt),
              ),
            )
        )[0]!.n
        if (open >= orderCap()) {
          req.log.warn({ event: 'customer_order_cap', open, ip: req.ip }, 'audit')
          return reply.code(503).send({ error: 'venue_busy' })
        }

        const { coverChargeCents } = await loadSettings(db)
        const result = await placeOrder(db, {
          items: parsed,
          customerName,
          covers,
          coverChargeCents,
          note,
          clientKey,
          createdBy: null,
          origin: 'customer',
          publicToken: randomBytes(24).toString('base64url'),
          paymentMethod: provider ? provider.method : null,
        })
        if (!result.ok) {
          if (result.code === 'unknown_products') {
            return reply.code(400).send({ error: 'unknown_products', missing: result.ids })
          }
          if (result.code === 'products_unavailable') {
            return reply.code(409).send({ error: 'products_unavailable', unavailable: result.ids })
          }
          return reply.code(409).send({ error: 'out_of_stock', unavailable: result.ids })
        }

        // Replays: a held order replays with its resume URL; a released one
        // replays like phase A.
        if (result.replayed) {
          let paymentUrl: string | null = null
          if (isHeld(result.order) && provider) {
            paymentUrl = await provider.resumeUrl(result.order.paymentRef!).catch(() => null)
          }
          return reply.code(200).send({
            publicToken: result.order.publicToken,
            dailyNumber: result.order.dailyNumber,
            totalCents: result.order.totalCents,
            ...(paymentUrl ? { paymentUrl } : {}),
          })
        }

        // Online payment: create the hosted checkout BEFORE the order is
        // released. Held orders never print and never notify; if the
        // provider cannot take the payment, roll the order back (restock)
        // and let the customer fall back to paying at the counter.
        if (provider) {
          const returnUrl = `${req.protocol}://${req.headers.host}/o/${result.order.publicToken}`
          try {
            const payment = await provider.createPayment(result.order, returnUrl)
            await db
              .update(orders)
              .set({ paymentRef: payment.ref })
              .where(eq(orders.id, result.order.id))
            req.log.info(
              {
                event: 'online_payment_started',
                orderId: result.order.id,
                method: provider.method,
                ref: payment.ref,
                totalCents: result.order.totalCents,
              },
              'audit',
            )
            return reply.code(201).send({
              publicToken: result.order.publicToken,
              dailyNumber: result.order.dailyNumber,
              totalCents: result.order.totalCents,
              paymentUrl: payment.redirectUrl,
            })
          } catch (err) {
            req.log.warn({ err, orderId: result.order.id }, 'online payment unavailable')
            await expireHeldOrder(db, result.order, req.log)
            return reply.code(503).send({ error: 'payment_unavailable' })
          }
        }

        req.log.info(
          {
            event: 'customer_order',
            orderId: result.order.id,
            dailyNumber: result.order.dailyNumber,
            totalCents: result.order.totalCents,
            ip: req.ip,
          },
          'audit',
        )
        printKitchenTicket(db, result.order).catch((err) =>
          req.log.error(err, 'kitchen print crashed'),
        )
        notifyOrdersChanged()

        // Only what the customer needs — no internal ids.
        return reply.code(201).send({
          publicToken: result.order.publicToken,
          dailyNumber: result.order.dailyNumber,
          totalCents: result.order.totalCents,
        })
      },
    )

    /** Follow your own order: token only, never a guessable id. */
    app.get(
      '/api/public/orders/:token',
      { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (req, reply) => {
        if (!(await enabled())) return reply.code(404).send({ error: 'not_found' })

        const token = (req.params as { token: string }).token
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
          return reply.code(404).send({ error: 'not_found' })
        }
        let order = (
          await db.select().from(orders).where(eq(orders.publicToken, token)).limit(1)
        )[0]
        if (!order) return reply.code(404).send({ error: 'not_found' })

        // The customer's own polling doubles as payment verification: their
        // return from the hosted checkout lands here.
        let paymentUrl: string | null = null
        if (isHeld(order)) {
          try {
            const outcome = await verifyHeldOrder(db, providers, order, req.log)
            order = (
              await db.select().from(orders).where(eq(orders.id, order.id)).limit(1)
            )[0]!
            if (outcome === 'pending') {
              const provider = providers.get(order.paymentMethod as OnlineMethod)
              paymentUrl = provider
                ? await provider.resumeUrl(order.paymentRef!).catch(() => null)
                : null
            }
          } catch (err) {
            req.log.warn({ err, orderId: order.id }, 'payment verify failed; still pending')
          }
        }

        const items = await db
          .select({
            nameSnapshot: orderItems.nameSnapshot,
            priceCentsSnapshot: orderItems.priceCentsSnapshot,
            qty: orderItems.qty,
            doneAt: orderItems.doneAt,
            cancelledAt: orderItems.cancelledAt,
          })
          .from(orderItems)
          .where(eq(orderItems.orderId, order.id))

        const paymentState = order.paymentRef
          ? order.paidAt
            ? 'paid'
            : order.cancelledAt
              ? 'failed'
              : 'pending'
          : 'none'

        return {
          dailyNumber: order.dailyNumber,
          customerName: order.customerName,
          covers: order.covers,
          coverChargeCents: order.coverChargeCents,
          totalCents: order.totalCents,
          createdAt: order.createdAt,
          completedAt: order.completedAt,
          cancelledAt: order.cancelledAt,
          paidAt: order.paidAt,
          paymentState,
          ...(paymentUrl ? { paymentUrl } : {}),
          items,
        }
      },
    )
  }
}
