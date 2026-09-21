/**
 * What the cashier types into the "received" box, as cents. Forgiving on
 * purpose — a till is no place for a validation error: "20", "20,5",
 * "20.50", "€ 20" and " 20 " all mean 2000. Empty or nonsense is null, which
 * the calculator shows as nothing at all rather than as €0,00 change.
 */
export function parseMoneyInput(raw: string): number | null {
  const s = raw.replace(/[^\d.,]/g, '')
  if (!s) return null
  // The last separator is the decimal one; any other is a thousands mark.
  const cut = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'))
  const whole = (cut === -1 ? s : s.slice(0, cut)).replace(/[.,]/g, '')
  const frac = cut === -1 ? '' : s.slice(cut + 1).replace(/[.,]/g, '')
  if (!/^\d*$/.test(whole) || !/^\d{0,2}$/.test(frac) || (!whole && !frac)) return null
  return Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2))
}

/** The inverse, in the form the cashier would have typed: 2050 → "20,50". */
export function centsToInput(cents: number): string {
  const whole = Math.floor(cents / 100)
  const frac = cents % 100
  return frac === 0 ? String(whole) : `${whole},${String(frac).padStart(2, '0')}`
}
