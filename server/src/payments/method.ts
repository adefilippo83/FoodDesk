import type { OnlineMethod } from './provider.js'

/**
 * Payment methods fall in two families with different rules:
 *
 * - counter (cash, POS): a person with the money in hand. Nothing to verify,
 *   nothing to refund automatically — a manager can re-charge or hand cash
 *   back — so the order stays editable like any other.
 * - online (Stripe, PayPal): held until the provider confirms, refunded by
 *   API on cancel, and its lines are frozen because there are no partial
 *   refunds.
 *
 * Every guard that means "online" goes through isOnlinePayment(), never
 * through `!== 'cash'`: the latter silently lumps POS in with the providers.
 */

export const COUNTER_METHODS = ['cash', 'pos'] as const
export type CounterMethod = (typeof COUNTER_METHODS)[number]

export function isOnlinePayment(method: string | null | undefined): method is OnlineMethod {
  return method === 'stripe' || method === 'paypal'
}

/**
 * The counter's choice from a request body. Absent means cash — the default
 * every pre-0.2.9 client implicitly sent — so an old PWA still works.
 */
export function parseCounterMethod(raw: unknown): CounterMethod | 'invalid' {
  if (raw === undefined || raw === null) return 'cash'
  return raw === 'cash' || raw === 'pos' ? raw : 'invalid'
}
