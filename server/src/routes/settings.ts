import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth } from '../auth/acl.js'
import type { Db } from '../db/index.js'
import { kitchenQueue } from '../print/service.js'
import { renderOrderSheet, renderReceipt } from '../print/pdf.js'
import { loadSettings, saveSettings } from '../settings.js'
import type { Order, OrderItem } from '../db/schema.js'

export function settingsRoutes(db: Db) {
  return async function register(app: FastifyInstance) {
    /**
     * What a waiter's client needs: coperto amount, printer state, and the
     * order-sheet layout fields the browser auto-print fallback renders.
     */
    app.get('/api/config', { preHandler: requireAuth }, async () => {
      const s = await loadSettings(db)
      return {
        restaurantName: s.restaurantName,
        coverChargeCents: s.coverChargeCents,
        printerConfigured: Boolean(kitchenQueue()),
        orderHeaderText: s.orderHeaderText,
        orderHeaderImage: s.orderHeaderImage,
        orderFooterText: s.orderFooterText,
        orderFooterImage: s.orderFooterImage,
        orderDisclaimer: s.orderDisclaimer,
        orderCategoryStyle: s.orderCategoryStyle,
        orderHeaderFontSize: s.orderHeaderFontSize,
        orderFooterFontSize: s.orderFooterFontSize,
        orderDisclaimerFontSize: s.orderDisclaimerFontSize,
        orderHeaderImageWidthPct: s.orderHeaderImageWidthPct,
        orderFooterImageWidthPct: s.orderFooterImageWidthPct,
      }
    })

    app.get('/api/settings', { preHandler: requireAdmin }, async () => loadSettings(db))

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
        return loadSettings(db)
      },
    )

    /**
     * A sample document with the current settings — the admin preview button.
     * ?kind=order previews the order sheet; anything else the receipt.
     */
    app.get('/api/settings/preview.pdf', { preHandler: requireAdmin }, async (req, reply) => {
      const kind = (req.query as { kind?: string }).kind === 'order' ? 'order' : 'receipt'
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
        },
      ] satisfies OrderItem[]

      const pdf =
        kind === 'order'
          ? await renderOrderSheet(order, items, s)
          : await renderReceipt(order, items, s)
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', 'inline; filename="preview.pdf"')
        .send(pdf)
    })
  }
}
