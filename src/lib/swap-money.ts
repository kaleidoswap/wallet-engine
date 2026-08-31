/**
 * swap-money
 * ----------
 * Fail-closed coercion for money fields arriving from the maker API.
 *
 * Extracted from `KaleidoswapSwap` so the two code paths that consume the SAME
 * maker responses coerce them the same way. They did not: the WDK path
 * (`src/swap/KaleidoswapSwap.ts`) has coerced every amount, fee, price and
 * expiry since the swap hardening, while the native path
 * (`RgbAdapter.getSwapQuote` / `getSwapStatus`) took each field raw off the wire
 * — so a negative `final_fee` and an amount past 2^53 both passed through
 * unchecked on one path and were rejected on the other (audit finding E-F4).
 *
 * SCOPE. This checks the SHAPE of a value, never its meaning. It does not
 * compare anything the maker returned against what the user asked for — neither
 * amounts nor asset ids. That is a separate, open question (finding B-F1:
 * maker-authored amounts and asset ids are never checked against the request,
 * and on the native path `fromAsset`/`toAsset` come from the response), and it
 * needs a product decision about whether the engine should re-validate and fail
 * closed. Do not grow this function into that.
 */

import { ProtocolError } from '../types/base'

/**
 * Coerce an SDK money field to a number, failing CLOSED on values that would
 * silently corrupt: `NaN`/`Infinity` (a renamed/missing field), a negative
 * value (a hostile/buggy maker returning a negative fee/amount/price that would
 * poison downstream net-amount math), or magnitudes past `Number.MAX_SAFE_INTEGER`
 * where JS would lose integer precision. Every field this coerces — amounts,
 * fees, price, expiry timestamp — is non-negative by definition. Money must
 * never flow through as a quietly-wrong number.
 *
 * Note the missing-field case is deliberate rather than defaulted: a counterparty
 * must not be able to switch off a safety check by leaving a field out.
 */
export function toSwapAmount(value: unknown, field: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    throw new ProtocolError(
      `Swap response field '${field}' is not a finite number`,
      'RGB_LN',
      'BAD_AMOUNT',
    )
  }
  if (n < 0) {
    throw new ProtocolError(`Swap response field '${field}' is negative`, 'RGB_LN', 'BAD_AMOUNT')
  }
  if (n > Number.MAX_SAFE_INTEGER) {
    throw new ProtocolError(
      `Swap response field '${field}' exceeds safe integer precision`,
      'RGB_LN',
      'BAD_AMOUNT',
    )
  }
  return n
}
