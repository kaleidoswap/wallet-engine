/**
 * amount
 * ------
 * The single source of truth for rendering raw integer balances into display
 * strings. Every adapter's `totalDisplay`/`availableDisplay` and tx `amountDisplay`
 * goes through here, so a 1.00-unit balance never leaks to the UI as its raw
 * base-unit integer. Pure, no I/O.
 */

/**
 * Render a raw integer amount in an asset's display precision, e.g.
 * `formatAmount(100_000_000, 8)` → `"1.00000000"`. Always emits exactly `precision`
 * fractional digits; non-positive precision renders the integer as-is.
 */
export function formatAmount(amount: number, precision: number): string {
  if (precision <= 0) return String(Math.trunc(amount))
  return (amount / Math.pow(10, precision)).toFixed(precision)
}

/** BTC display for a satoshi integer: `formatAmount(sats, 8)`. */
export function formatSats(sats: number): string {
  return formatAmount(sats, 8)
}
