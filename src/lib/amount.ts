/**
 * amount
 * ------
 * The single source of truth for rendering raw integer balances/amounts into
 * human-readable display strings. Every adapter's `totalDisplay`/`availableDisplay`
 * and tx `amountDisplay` must go through here so a 1.00-unit balance never leaks
 * to the UI as its raw base-unit integer (e.g. "100000000").
 *
 * Pure, no I/O. Previously duplicated as `formatAmount` in rgb-helpers and
 * spark-helpers and as `formatUnits`/`formatSats` in arkade-helpers — those now
 * re-export from here.
 */

/**
 * Render a raw integer amount in an asset's display precision, e.g.
 * `formatAmount(100_000_000, 8)` → `"1.00000000"`. Always emits exactly
 * `precision` fractional digits; callers wanting a tighter rendering trim
 * trailing zeros themselves. Non-positive precision renders the integer as-is.
 *
 * MUST NOT THROW. `precision` is issuer-supplied — RGB asset precision and Spark
 * token `decimals` both come off the wire — and this function sits inside the
 * `listAssets` / `listTransactions` render loop that every adapter feeds. The
 * previous `(amount / 10**precision).toFixed(precision)` threw `RangeError` for
 * `precision > 100` (`toFixed` accepts 0-100; RGB precision is a `u8`), so one
 * dust transfer of a crafted asset took out the whole asset list and activity
 * view — denial of service on wallet enumeration, recoverable only with another
 * tool. Digit-shifting a BigInt has no such ceiling, and is exact rather than
 * float-rounded for large base-unit counts.
 *
 * Out-of-contract inputs are rendered, never thrown on: a non-finite `amount`
 * stringifies as-is (`"NaN"`, `"Infinity"`), and a fractional one is truncated —
 * the same `Math.trunc` the non-positive-precision branch has always applied.
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
