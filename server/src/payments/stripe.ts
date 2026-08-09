import type { Order } from '../db/schema.js'
import type { CreatedPayment, PaymentCheck, PaymentProvider } from './provider.js'

/**
 * Stripe via plain REST (Checkout Sessions) — no SDK dependency. Hosted
 * checkout keeps card data entirely on Stripe's side and our CSP untouched.
 * STRIPE_API_BASE exists so tests can point at a local mock server.
 */

const BASE = () => process.env.STRIPE_API_BASE ?? 'https://api.stripe.com'
const CURRENCY = () => (process.env.STRIPE_CURRENCY ?? 'eur').toLowerCase()

async function stripeReq(
  key: string,
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const err = body.error as { message?: string } | undefined
    throw new Error(`stripe ${path}: ${res.status} ${err?.message ?? 'unknown error'}`)
  }
  return body
}

export function stripeProvider(secretKey: string): PaymentProvider {
  return {
    method: 'stripe',

    async createPayment(order: Order, returnUrl: string): Promise<CreatedPayment> {
      const session = await stripeReq(secretKey, 'POST', '/v1/checkout/sessions', {
        mode: 'payment',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': CURRENCY(),
        'line_items[0][price_data][unit_amount]': String(order.totalCents),
        'line_items[0][price_data][product_data][name]': `#${String(order.dailyNumber).padStart(3, '0')} · ${order.customerName ?? 'FoodDesk'}`,
        success_url: returnUrl,
        cancel_url: returnUrl,
        // Ties the session to our order for reconciliation from either side.
        'metadata[fooddesk_order]': String(order.id),
      })
      return { ref: String(session.id), redirectUrl: String(session.url) }
    },

    async verifyPayment(ref: string): Promise<PaymentCheck> {
      const session = await stripeReq(secretKey, 'GET', `/v1/checkout/sessions/${ref}`)
      if (session.payment_status === 'paid') return 'paid'
      if (session.status === 'expired') return 'failed'
      return 'pending'
    },

    async cancelPayment(ref: string): Promise<void> {
      // Expiring the session guarantees no late payment can complete. If the
      // session already completed, Stripe rejects this — the thrown error
      // makes the caller keep the order held, and the next verify sees paid.
      await stripeReq(secretKey, 'POST', `/v1/checkout/sessions/${ref}/expire`)
    },

    async resumeUrl(ref: string): Promise<string | null> {
      const session = await stripeReq(secretKey, 'GET', `/v1/checkout/sessions/${ref}`)
      return typeof session.url === 'string' ? session.url : null
    },

    async refund(ref: string): Promise<void> {
      const session = await stripeReq(secretKey, 'GET', `/v1/checkout/sessions/${ref}`)
      const intent = session.payment_intent
      if (typeof intent !== 'string' || !intent) {
        throw new Error('stripe refund: session has no payment_intent')
      }
      await stripeReq(secretKey, 'POST', '/v1/refunds', { payment_intent: intent })
    },
  }
}
