import { randomBytes } from 'node:crypto'
import { and, count, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Db } from '../db/index.js'
import { categories, orderItems, orders, products } from '../db/schema.js'
import { notifyOrdersChanged } from '../lib/events.js'
import { openOrdersStream } from '../lib/sse.js'
import { parseItems, placeOrder } from '../lib/placeOrder.js'
import { serviceDayOf } from '../lib/serviceDay.js'
import { expireHeldOrder, isHeld, verifyHeldOrder } from '../payments/lifecycle.js'
import type { OnlineMethod, ProviderRegistry } from '../payments/provider.js'
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

// A held SSE socket costs a file descriptor and an event-bus listener for its
// whole lifetime. The per-IP rate limit caps the connect RATE but not how many
// stay open, so an attacker could hold thousands and exhaust the process. Cap
// concurrent public streams globally and per IP, and force-close a stream after
// an absolute lifetime (the client's EventSource reconnects on its own).
const MAX_PUBLIC_SSE_TOTAL = 200
const MAX_PUBLIC_SSE_PER_IP = 5
const PUBLIC_SSE_MAX_LIFETIME_MS = 30 * 60 * 1000

/**
 * Where the provider should send the customer back to after paying.
 *
 * The Host header is client-controlled and nginx passes it straight through
 * (`proxy_set_header Host $host`), so it cannot be trusted on its own: an
 * attacker could mint a payment link whose return URL points at their site
 * and hand it to a victim, who pays for real and then lands on a page of the
 * attacker's choosing. But the appliance has no fixed name — customers reach
 * it as 10.42.0.1 or fooddesk.local — so we cannot simply ignore the header.
 *
 * The rule: an explicit PUBLIC_BASE_URL always wins; otherwise the Host is
 * accepted only when it names something on the local network, which cannot
 * be used to send a victim anywhere interesting. Anything else (a public
 * domain, i.e. a deployment behind a real proxy) must set PUBLIC_BASE_URL —
 * without it we fall back to the address we are actually listening on.
 */
const HOST_RE = /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/

function isLocalAuthority(host: string): boolean {
  const name = host.replace(/:\d+$/, '').toLowerCase()
  if (name === 'localhost' || name.endsWith('.local')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  if (!m) return false
  const parts = m.slice(1).map(Number)
  if (parts.some((n) => n > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  )
}

function publicBase(req: FastifyRequest): string {
  const configured = process.env.PUBLIC_BASE_URL
  if (configured) return configured.replace(/\/+$/, '')
  const host = String(req.headers.host ?? '')
  if (HOST_RE.test(host) && isLocalAuthority(host)) return `${req.protocol}://${host}`
  // Not a local address: fall back to what we are listening on. (req.hostname
  // is no help — Fastify derives it from the very header we are distrusting.)
  const sock = req.raw.socket
  let addr = sock.localAddress ?? 'localhost'
  if (addr.startsWith('::ffff:')) addr = addr.slice(7)
  const authority = addr.includes(':') ? `[${addr}]` : addr
  const port = sock.localPort
  const suffix = port && port !== 80 && port !== 443 ? `:${port}` : ''
  return `${req.protocol}://${authority}${suffix}`
}

export function publicRoutes(db: Db, providers: ProviderRegistry) {
  let publicSseTotal = 0
  const publicSsePerIp = new Map<string, number>()

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
            stockRemaining: products.stockRemaining,
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
          products: { id: number; name: string; priceCents: number; stockRemaining: number | null }[]
        }[] = []
        for (const r of rows) {
          let cat = menu.find((c) => c.id === r.categoryId)
          if (!cat) {
            cat = { id: r.categoryId, name: r.categoryName, products: [] }
            menu.push(cat)
          }
          cat.products.push({
            id: r.productId,
            name: r.productName,
            priceCents: r.priceCents,
            stockRemaining: r.stockRemaining,
          })
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

        // A retry of an order that already landed is not a new order, so it
        // must not be turned away by the cap — the customer would be stuck
        // with an order they cannot see. Let placeOrder replay it instead.
        const isReplay = clientKey
          ? Boolean(
              (
                await db
                  .select({ id: orders.id })
                  .from(orders)
                  .where(eq(orders.clientKey, clientKey))
                  .limit(1)
              )[0],
            )
          : false

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
        if (!isReplay && open >= orderCap()) {
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
          if (result.code === 'payload_mismatch') {
            return reply.code(409).send({ error: 'payload_mismatch' })
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
          const returnUrl = `${publicBase(req)}/o/${result.order.publicToken}`
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
        // No kitchen ticket yet: a counter order starts cooking only when
        // it is paid at the register (the mark-paid action prints it).
        notifyOrdersChanged()

        // Only what the customer needs — no internal ids.
        return reply.code(201).send({
          publicToken: result.order.publicToken,
          dailyNumber: result.order.dailyNumber,
          totalCents: result.order.totalCents,
        })
      },
    )

    /**
     * Live nudges for the status page: a bare "orders" ping whenever any
     * order changes, so the phone refetches at once instead of leaning on
     * its polling loop. Token-checked like the status route; the stream
     * itself carries no order data.
     */
    app.get(
      '/api/public/orders/:token/events',
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (req, reply) => {
        if (!(await enabled())) return reply.code(404).send({ error: 'not_found' })
        const token = (req.params as { token: string }).token
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
          return reply.code(404).send({ error: 'not_found' })
        }
        const known = (
          await db
            .select({ id: orders.id })
            .from(orders)
            .where(eq(orders.publicToken, token))
            .limit(1)
        )[0]
        if (!known) return reply.code(404).send({ error: 'not_found' })

        // Refuse when the global or per-IP ceiling is reached: better to drop
        // the live nudge (the phone still polls) than to exhaust the server.
        const ip = req.ip
        const perIp = publicSsePerIp.get(ip) ?? 0
        if (publicSseTotal >= MAX_PUBLIC_SSE_TOTAL || perIp >= MAX_PUBLIC_SSE_PER_IP) {
          return reply.code(503).send({ error: 'too_many_streams' })
        }

        publicSseTotal++
        publicSsePerIp.set(ip, perIp + 1)
        openOrdersStream(req, reply, {
          maxLifetimeMs: PUBLIC_SSE_MAX_LIFETIME_MS,
          onClose: () => {
            publicSseTotal--
            const n = (publicSsePerIp.get(ip) ?? 1) - 1
            if (n <= 0) publicSsePerIp.delete(ip)
            else publicSsePerIp.set(ip, n)
          },
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

        // The customer's own order, with their name on it: not for any
        // shared cache sitting between the phone and the venue box.
        reply.header('cache-control', 'no-store')
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
