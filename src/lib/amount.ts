/** Exact display formatting for raw integer asset amounts. */

/**
 * Render a raw integer amount in an asset's display precision, e.g.
 * `formatAmount(100_000_000, 8)` → `"1.00000000"`. Always emits exactly `precision`
 * fractional digits; non-positive precision renders the integer as-is.
 *
 * Issuer-supplied precision must not make asset rendering throw; BigInt shifting
 * remains exact without `toFixed`'s precision ceiling.
 */
export function formatAmount(amount: number, precision: number): string {
  if (!Number.isFinite(amount)) return String(amount)
  const digits = Number.isFinite(precision) ? Math.trunc(precision) : 0
  if (digits <= 0) return String(Math.trunc(amount))

  const units = BigInt(Math.trunc(amount))
  const negative = units < 0n
  // Pad to at least one whole digit so a value smaller than one unit renders
  // "0.000…" rather than an empty integer part.
  const abs = (negative ? -units : units).toString().padStart(digits + 1, '0')
  const split = abs.length - digits
  return `${negative ? '-' : ''}${abs.slice(0, split)}.${abs.slice(split)}`
}

/** BTC display for a satoshi integer: `formatAmount(sats, 8)`. */
export function formatSats(sats: number): string {
  return formatAmount(sats, 8)
}
