import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth, requireManager } from '../auth/acl.js'
import type { Db } from '../db/index.js'
import { kitchenQueue } from '../print/service.js'
import { kitchenFeatureEnabled } from './kitchen.js'
import { renderKitchenTicket, renderOrderSheet, renderReceipt } from '../print/pdf.js'
import { renderCustomerQr } from '../print/customerQr.js'
import { createHash } from 'node:crypto'
import { APP_VERSION, imageBuffer, loadSettings, saveSettings } from '../settings.js'
import type { Order, OrderItem } from '../db/schema.js'

import type { ProviderRegistry } from '../payments/provider.js'

export function settingsRoutes(db: Db, providers: ProviderRegistry) {
  return async function register(app: FastifyInstance) {
    /** Cheap feature flags — the UI decides which doors to draw. */
    app.get('/api/features', { preHandler: requireAuth }, async () => ({
      kitchenEnabled: await kitchenFeatureEnabled(db),
    }))

    /**
     * What a waiter's client needs: coperto amount, printer state, and the
     * order-sheet layout fields the browser auto-print fallback renders.
     * Images travel as versioned, immutably-cached URLs — not as megabytes
     * of base64 re-downloaded on every New Order mount.
     */
    app.get('/api/config', { preHandler: requireAuth }, async () => {
      const s = await loadSettings(db)
      const assetUrl = (kind: 'header' | 'footer', dataUrl: string) =>
        dataUrl
          ? `/api/order-assets/${kind}?v=${createHash('sha1').update(dataUrl).digest('hex').slice(0, 8)}`
          : ''
      return {
        restaurantName: s.restaurantName,
        coverChargeCents: s.coverChargeCents,
        printerConfigured: Boolean(kitchenQueue()),
        orderHeaderText: s.orderHeaderText,
        orderHeaderImageUrl: assetUrl('header', s.orderHeaderImage),
        orderFooterText: s.orderFooterText,
        orderFooterImageUrl: assetUrl('footer', s.orderFooterImage),
        orderDisclaimer: s.orderDisclaimer,
        orderCategoryStyle: s.orderCategoryStyle,
        orderHeaderFontSize: s.orderHeaderFontSize,
        orderFooterFontSize: s.orderFooterFontSize,
        orderDisclaimerFontSize: s.orderDisclaimerFontSize,
        orderHeaderImageWidthPct: s.orderHeaderImageWidthPct,
        orderFooterImageWidthPct: s.orderFooterImageWidthPct,
      }
    })

    /**
     * Printable QR sheet for customer self-ordering: an A4 poster plus four
     * table cards. The encoded URL is derived from the Host the admin used,
     * which is exactly the address customers on the same network need.
     */
    app.get('/api/settings/customer-qr.pdf', { preHandler: requireManager }, async (req, reply) => {
      const s = await loadSettings(db)
      const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim()
      const proto = forwarded || req.protocol
      const orderUrl = `${proto}://${req.headers.host ?? 'localhost'}/order`
      const pdf = await renderCustomerQr(orderUrl, s)
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', 'inline; filename="fooddesk-customer-qr.pdf"')
        .send(pdf)
    })

    /**
     * The order-sheet header/footer images as plain image responses. The
     * ?v= content hash in the URL changes on upload, so the response itself
     * can be cached forever.
     */
    app.get('/api/order-assets/:kind', { preHandler: requireAuth }, async (req, reply) => {
      const kind = (req.params as { kind: string }).kind
      if (kind !== 'header' && kind !== 'footer') {
        return reply.code(404).send({ error: 'not_found' })
      }
      const s = await loadSettings(db)
      const dataUrl = kind === 'header' ? s.orderHeaderImage : s.orderFooterImage
      const buf = dataUrl ? imageBuffer(dataUrl) : null
      if (!buf) return reply.code(404).send({ error: 'not_found' })
      return reply
        .header('content-type', dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg')
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(buf)
    })

    // version rides along read-only so the Settings page can show which
    // release is running (issue #33); saveSettings ignores it on PUT.
    app.get('/api/settings', { preHandler: requireAdmin }, async () => ({
      ...(await loadSettings(db)),
      version: APP_VERSION,
      // Read-only: which online payment providers the env configures.
      paymentProviders: [...providers.keys()],
    }))

    // The one route allowed a large body: base64 logo/background uploads.
    app.put(
      '/api/settings',
      { preHandler: requireAdmin, bodyLimit: 3 * 1024 * 1024 },
      async (req, reply) => {
        const body = req.body as Record<string, unknown> | undefined
        if (!body || typeof body !== 'object') {
          return reply.code(400).send({ error: 'invalid_body' })
        }
        const err = await saveSettings(db, body)
        if (err) return reply.code(400).send({ error: err.error, field: err.field })
        req.log.info(
          { event: 'settings_changed', by: req.user!.id, fields: Object.keys(body) },
          'audit',
        )
        return { ...(await loadSettings(db)), version: APP_VERSION, paymentProviders: [...providers.keys()] }
      },
    )

    /**
     * A sample document with the current settings — the admin preview button.
     * ?kind=order previews the order sheet, ?kind=kitchen the kitchen ticket;
     * anything else the receipt.
     */
    app.get('/api/settings/preview.pdf', { preHandler: requireAdmin }, async (req, reply) => {
      const rawKind = (req.query as { kind?: string }).kind
      const kind = rawKind === 'order' || rawKind === 'kitchen' ? rawKind : 'receipt'
      const s = await loadSettings(db)
      const now = Math.floor(Date.now() / 1000)
      const order = {
        id: 0,
        dailyNumber: 42,
        serviceDay: new Date().toISOString().slice(0, 10),
        customerName: 'Mario Rossi',
        covers: 3,
        coverChargeCents: s.coverChargeCents,
        cancelledAt: null,
        cancelledBy: null,
        completedAt: null,
        clientKey: null,
        origin: 'staff',
        publicToken: null,
        paidAt: null,
        paymentMethod: null,
        paymentRef: null,
        refundedAt: null,
        note: null,
        totalCents: 2 * 650 + 3 * 500 + 3 * s.coverChargeCents,
        createdBy: 0,
        createdAt: now,
        printedAt: null,
        printError: null,
        printAttempts: 0,
      } satisfies Order
      const items = [
        {
          id: 1,
          orderId: 0,
          productId: 0,
          nameSnapshot: 'Bruschetta',
          priceCentsSnapshot: 650,
          categoryNameSnapshot: 'Antipasti',
          qty: 2,
          note: null,
          doneAt: null,
          cancelledAt: null,
          cancelledBy: null,
        },
        {
          id: 2,
          orderId: 0,
          productId: 0,
          nameSnapshot: 'Birra',
          priceCentsSnapshot: 500,
          categoryNameSnapshot: 'Bevande',
          qty: 3,
          note: null,
          doneAt: null,
          cancelledAt: null,
          cancelledBy: null,
        },
      ] satisfies OrderItem[]

      const pdf =
        kind === 'order'
          ? await renderOrderSheet(order, items, s)
          : kind === 'kitchen'
            ? await renderKitchenTicket(order, items, s)
            : await renderReceipt(order, items, s)
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', 'inline; filename="preview.pdf"')
        .send(pdf)
    })
  }
}
