import type { Order } from '../db/schema.js'
import { PROVIDER_TIMEOUT_MS } from './http.js'
import type { CreatedPayment, PaymentCheck, PaymentProvider } from './provider.js'

/**
 * PayPal via the Orders API v2, plain REST — hosted approval page, no SDK.
 * Two-step by design: the customer *approves*, then WE capture — which
 * happens inside verifyPayment (the interface anticipates providers that
 * complete work during verification). Nothing moves money except our own
 * capture call, which is also what makes expiry safe without a void API.
 * PAYPAL_API_BASE exists so tests can point at a local mock server.
 */

const BASE = () =>
  process.env.PAYPAL_API_BASE ??
  (process.env.PAYPAL_ENV === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com')
const CURRENCY = () => (process.env.PAYPAL_CURRENCY ?? 'EUR').toUpperCase()

type Json = Record<string, unknown>
type PayPalRes = { status: number; body: Json }

function firstIssue(body: Json): string | undefined {
  const details = body.details as { issue?: string }[] | undefined
  return details?.[0]?.issue
}

function approveLink(body: Json): string | null {
  const links = (body.links ?? []) as { rel?: string; href?: string }[]
  const link = links.find((l) => l.rel === 'approve' || l.rel === 'payer-action')
  return link?.href ?? null
}

export function paypalProvider(clientId: string, clientSecret: string): PaymentProvider {
  // OAuth client-credentials token, cached with a five-minute safety margin.
  let token: { value: string; expiresAt: number } | null = null

  async function accessToken(force = false): Promise<string> {
    if (!force && token && Date.now() < token.expiresAt) return token.value
    const res = await fetch(`${BASE()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => ({}))) as Json
    if (!res.ok || typeof body.access_token !== 'string') {
      throw new Error(`paypal oauth: ${res.status}`)
    }
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 0
    token = { value: body.access_token, expiresAt: Date.now() + Math.max(60, ttl - 300) * 1000 }
    return token.value
  }

  async function req(method: 'GET' | 'POST', path: string, payload?: Json): Promise<PayPalRes> {
    const call = async (tok: string) =>
      fetch(`${BASE()}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${tok}`,
          'content-type': 'application/json',
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      })
    let res = await call(await accessToken())
    // A stale cached token gets exactly one refresh-and-retry.
    if (res.status === 401) res = await call(await accessToken(true))
    const body = (await res.json().catch(() => ({}))) as Json
    return { status: res.status, body }
  }

  function fail(what: string, r: PayPalRes): never {
    throw new Error(
      `paypal ${what}: ${r.status} ${String(r.body.name ?? '')} ${String(r.body.message ?? '')}`.trim(),
    )
  }

  /** APPROVED → capture. The two benign races both resolve correctly. */
  async function capture(ref: string): Promise<PaymentCheck> {
    const r = await req('POST', `/v2/checkout/orders/${ref}/capture`, {})
    if (r.status === 200 || r.status === 201) {
      return r.body.status === 'COMPLETED' ? 'paid' : 'pending'
    }
    const issue = firstIssue(r.body)
    // Someone (our own sweeper) captured a moment ago: that IS paid.
    if (issue === 'ORDER_ALREADY_CAPTURED') return 'paid'
    // Funding source bounced: the customer can approve again with another.
    if (issue === 'INSTRUMENT_DECLINED') return 'pending'
    fail('capture', r)
  }

  return {
    method: 'paypal',

    async createPayment(order: Order, returnUrl: string): Promise<CreatedPayment> {
      const r = await req('POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: String(order.id),
            description: `#${String(order.dailyNumber).padStart(3, '0')} · ${order.customerName ?? 'FoodDesk'}`,
            amount: {
              currency_code: CURRENCY(),
              value: (order.totalCents / 100).toFixed(2),
            },
          },
        ],
        application_context: {
          return_url: returnUrl,
          cancel_url: returnUrl,
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
        },
      })
      if (r.status !== 200 && r.status !== 201) fail('create', r)
      const url = approveLink(r.body)
      if (typeof r.body.id !== 'string' || !url) fail('create (no approve link)', r)
      return { ref: r.body.id, redirectUrl: url }
    },

    async verifyPayment(ref: string): Promise<PaymentCheck> {
      const r = await req('GET', `/v2/checkout/orders/${ref}`)
      if (r.status === 404) return 'failed'
      if (r.status !== 200) fail('verify', r)
      const status = r.body.status
      if (status === 'COMPLETED') return 'paid'
      if (status === 'APPROVED') return capture(ref)
      if (status === 'VOIDED') return 'failed'
      return 'pending' // CREATED / PAYER_ACTION_REQUIRED / SAVED
    },

    async cancelPayment(ref: string): Promise<void> {
      // PayPal has no void for a checkout order — and needs none: nothing
      // moves money except our own capture, so "we will never capture" IS
      // the guarantee. Only an already-captured order must stay held (throw)
      // so the next verify delivers it instead of losing the money.
      const r = await req('GET', `/v2/checkout/orders/${ref}`)
      if (r.status === 200 && r.body.status === 'COMPLETED') {
        throw new Error('paypal: order already captured')
      }
    },

    async refund(ref: string): Promise<void> {
      const r = await req('GET', `/v2/checkout/orders/${ref}`)
      if (r.status !== 200) fail('refund lookup', r)
      const units = r.body.purchase_units as
        | { payments?: { captures?: { id?: string }[] } }[]
        | undefined
      const captureId = units?.[0]?.payments?.captures?.[0]?.id
      if (!captureId) throw new Error('paypal refund: order has no capture')
      const rr = await req('POST', `/v2/payments/captures/${captureId}/refund`, {})
      if (rr.status !== 200 && rr.status !== 201) fail('refund', rr)
    },

    async resumeUrl(ref: string): Promise<string | null> {
      const r = await req('GET', `/v2/checkout/orders/${ref}`)
      if (r.status !== 200) return null
      return approveLink(r.body)
    },
  }
}
