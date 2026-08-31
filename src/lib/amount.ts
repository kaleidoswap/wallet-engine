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
 *
 * MUST NOT THROW (audit E-F1b). `precision` is issuer-supplied and this sits in
 * the `listAssets`/`listTransactions` render loop, so the old
 * `(amount / 10**precision).toFixed(precision)` took out the whole asset list on
 * any asset declaring `precision > 100` (`toFixed` accepts 0-100; RGB precision
 * is a `u8`). BigInt digit-shifting has no ceiling and is exact. Out-of-contract
 * inputs render rather than throw: non-finite amounts stringify as-is, fractional
 * ones are truncated.
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
