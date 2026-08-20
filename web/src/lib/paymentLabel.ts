/**
 * How a payment method is written on screen. Brand names are never
 * translated; "counter" is the only one that is a word in the venue's
 * language. Kept in one place so a third provider is a one-line change.
 */
export function paymentLabel(
  method: string | null | undefined,
  t: (key: 'payMethodCounter') => string,
): string {
  if (method === 'stripe') return 'Stripe'
  if (method === 'paypal') return 'PayPal'
  return t('payMethodCounter')
}
