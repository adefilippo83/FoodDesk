/**
 * Deadline for every outbound call to a payment provider. The venue box talks
 * to Stripe/PayPal over whatever uplink the festival has (or a phone tether),
 * so a stalled connection is a normal event, not an exception: without a
 * deadline it would hold a sweep pass — and a customer's status poll — open
 * indefinitely. Kept in its own module so both providers can share it without
 * importing the registry that imports them.
 */
export const PROVIDER_TIMEOUT_MS = 15_000
