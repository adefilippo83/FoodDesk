/**
 * How a payment method is written on screen. Brand names are never
 * translated; the counter's methods — cash, the POS terminal, and "counter"
 * for orders from before the two were told apart — are words in the venue's
 * language. Kept in one place so a new method is a one-line change.
 */
export function paymentLabel(
  method: string | null | undefined,
  t: (key: 'payMethodCounter' | 'payMethodCash' | 'payMethodPos') => string,
): string {
  if (method === 'stripe') return 'Stripe'
  if (method === 'paypal') return 'PayPal'
  if (method === 'cash') return t('payMethodCash')
  if (method === 'pos') return t('payMethodPos')
  return t('payMethodCounter')
}

/**
 * An online payment is held, refunded by API and has its lines frozen; a
 * counter payment (cash, POS) is none of those. Same rule as the server's.
 */
export function isOnlinePayment(method: string | null | undefined): boolean {
  return method === 'stripe' || method === 'paypal'
}
