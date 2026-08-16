/**
 * A unique idempotency key for an order submission. `crypto.randomUUID` only
 * exists in a secure context, but the venue LAN — and the Raspberry Pi
 * appliance behind the QR code — is plain http, where it is undefined and
 * throws. Fall back to a timestamp + random string there.
 */
export function newClientKey(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`
}
