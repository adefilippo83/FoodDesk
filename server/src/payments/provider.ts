import type { Order } from '../db/schema.js'
import { paypalProvider } from './paypal.js'
import { stripeProvider } from './stripe.js'

/**
 * Online payment providers, all shaped the same way: hosted-checkout
 * redirect out, outbound-only API verification back. No webhooks — the
 * venue box has no public URL, so payment truth is always *fetched* from
 * the provider, never pushed to us and never trusted from the client.
 */

export type OnlineMethod = 'stripe' | 'paypal'

export type CreatedPayment = { ref: string; redirectUrl: string }

/** paid = money confirmed · pending = in flight · failed = definitively dead */
export type PaymentCheck = 'paid' | 'pending' | 'failed'

export interface PaymentProvider {
  readonly method: OnlineMethod
  /** Create the hosted payment; the customer's browser lands on returnUrl after. */
  createPayment(order: Order, returnUrl: string): Promise<CreatedPayment>
  /**
   * May complete provider-side work, not just read: PayPal's approve→capture
   * happens here. Must be safe to call repeatedly.
   */
  verifyPayment(ref: string): Promise<PaymentCheck>
  /**
   * Make sure a pending payment can never complete (order expiry). MUST
   * throw when that cannot be guaranteed — the caller then keeps the order
   * held rather than risking a paid-but-cancelled order.
   */
  cancelPayment(ref: string): Promise<void>
  /** Full refund of a completed payment. */
  refund(ref: string): Promise<void>
  /** The hosted-checkout URL for a still-pending payment (page refreshes,
   * replays) — null when the provider cannot resume it. */
  resumeUrl(ref: string): Promise<string | null>
}

export type ProviderRegistry = Map<OnlineMethod, PaymentProvider>

/** Providers are configured by env only — keys never live in the database
 * (which is snapshotted to backup sticks every 15 minutes). */
export function providersFromEnv(): ProviderRegistry {
  const registry: ProviderRegistry = new Map()
  if (process.env.STRIPE_SECRET_KEY) {
    registry.set('stripe', stripeProvider(process.env.STRIPE_SECRET_KEY))
  }
  if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) {
    registry.set(
      'paypal',
      paypalProvider(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET),
    )
  }
  return registry
}
