/** Shared fail-closed money coercion and quote binding for both maker paths. */

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

/** Reject non-finite, negative, or precision-losing maker money fields. */
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

/** Bind maker assets exactly and limit from-leg divergence to caller policy. */
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
