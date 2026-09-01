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
 * This module also owns quote/request validation. Keeping coercion and authority
 * checks at one boundary prevents the native and WDK maker paths from drifting.
 */

import { ProtocolError } from '../types/base'

/** Default maximum absolute divergence of the returned from-leg: 1%. */
export const DEFAULT_MAX_QUOTE_SLIPPAGE_BPS = 100

export interface RequestedSwapTerms {
  fromAsset: string
  toAsset: string
  fromAmount?: unknown
}

export interface ReturnedSwapTerms {
  fromAsset: string
  toAsset: string
  fromAmount: unknown
  toAmount: unknown
}

export interface ValidatedSwapTerms {
  fromAsset: string
  toAsset: string
  fromAmount: number
  toAmount: number
}

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

/** Coerce a raw base-unit leg that must be a positive safe integer. */
function toPositiveBaseUnits(value: unknown, field: string): number {
  const amount = toSwapAmount(value, field)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new ProtocolError(
      `Swap response field '${field}' must be a positive safe integer`,
      'RGB_LN',
      'BAD_AMOUNT',
    )
  }
  return amount
}

function quoteTolerance(value: number | undefined): number {
  const tolerance = value ?? DEFAULT_MAX_QUOTE_SLIPPAGE_BPS
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) {
    throw new ProtocolError(
      'maxQuoteSlippageBps must be a non-negative safe integer',
      'RGB_LN',
      'BAD_QUOTE_TOLERANCE',
      { maxQuoteSlippageBps: value },
    )
  }
  return tolerance
}

/**
 * Bind maker-authored quote terms to the caller's request.
 *
 * Asset ids must match exactly. The returned from-leg may differ only within
 * `maxQuoteSlippageBps`; the to-leg is the maker's price and is shape-checked,
 * not compared to a caller price expectation. Returned asset ids are validated
 * but the request's ids are always emitted as the authoritative values.
 */
export function validateSwapQuoteTerms(
  requested: RequestedSwapTerms,
  returned: ReturnedSwapTerms,
  maxQuoteSlippageBps?: number,
): ValidatedSwapTerms {
  if (returned.fromAsset !== requested.fromAsset || returned.toAsset !== requested.toAsset) {
    throw new ProtocolError(
      'Maker quote assets do not match the requested swap pair',
      'RGB_LN',
      'QUOTE_ASSET_MISMATCH',
      {
        requested: { fromAsset: requested.fromAsset, toAsset: requested.toAsset },
        returned: { fromAsset: returned.fromAsset, toAsset: returned.toAsset },
      },
    )
  }

  const requestedAmount = toPositiveBaseUnits(requested.fromAmount, 'requested.fromAmount')
  const returnedAmount = toPositiveBaseUnits(returned.fromAmount, 'quote.fromAmount')
  const toAmount = toPositiveBaseUnits(returned.toAmount, 'quote.toAmount')
  const toleranceBps = quoteTolerance(maxQuoteSlippageBps)
  const difference = BigInt(Math.abs(returnedAmount - requestedAmount))
  const divergenceNumerator = difference * 10_000n
  const outsideTolerance =
    divergenceNumerator > BigInt(requestedAmount) * BigInt(toleranceBps)

  if (outsideTolerance) {
    throw new ProtocolError(
      'Maker quote from-leg diverges beyond the configured tolerance',
      'RGB_LN',
      'QUOTE_AMOUNT_DIVERGENCE',
      {
        requested: requestedAmount,
        returned: returnedAmount,
        toleranceBps,
        divergenceBps: Number(divergenceNumerator) / requestedAmount,
      },
    )
  }

  return {
    fromAsset: requested.fromAsset,
    toAsset: requested.toAsset,
    fromAmount: returnedAmount,
    toAmount,
  }
}
