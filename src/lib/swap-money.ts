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

export interface ApprovedSwapTerms {
  fromAsset: string
  fromAmount: number
  toAsset: string
  toAmount: number
}

const normalizeSwapAsset = (asset: string) => (asset.toLowerCase() === 'btc' ? 'btc' : asset)

/**
 * The swapstring is what the taker's node whitelists, so it is the only place
 * the approved terms can be enforced: the maker returns it and the node knows
 * nothing about the quote. Refuse anything that differs from the approval.
 * `paymentHash`, when given, must match the hash the maker returned on init.
 */
export function verifySwapstring(
  swapstring: unknown,
  approved: ApprovedSwapTerms,
  paymentHash?: string,
): void {
  const mismatch = (reason: string): never => {
    throw new ProtocolError(
      `Maker swapstring does not match the approved quote: ${reason}`,
      'RGB_LN',
      'SWAPSTRING_MISMATCH',
      { reason },
    )
  }
  if (typeof swapstring !== 'string') return mismatch('swapstring is missing')
  const parts = swapstring.split('/')
  if (parts.length !== 6) return mismatch(`expected 6 fields, got ${parts.length}`)
  const [qtyFrom, fromAsset, qtyTo, toAsset, expiry, hash] = parts
  const sameAmount = (actual: string, expected: number) =>
    /^[0-9]+$/.test(actual) && BigInt(actual) === BigInt(expected)

  if (!sameAmount(qtyFrom, approved.fromAmount)) {
    mismatch(`from amount ${qtyFrom} != approved ${approved.fromAmount}`)
  }
  if (normalizeSwapAsset(fromAsset) !== normalizeSwapAsset(approved.fromAsset)) {
    mismatch(`from asset ${fromAsset} != approved ${approved.fromAsset}`)
  }
  if (!sameAmount(qtyTo, approved.toAmount)) {
    mismatch(`to amount ${qtyTo} != approved ${approved.toAmount}`)
  }
  if (normalizeSwapAsset(toAsset) !== normalizeSwapAsset(approved.toAsset)) {
    mismatch(`to asset ${toAsset} != approved ${approved.toAsset}`)
  }
  if (!/^[0-9]+$/.test(expiry)) mismatch('expiry is not a timestamp')
  if (!/^[0-9a-f]{64}$/i.test(hash)) mismatch('payment hash is malformed')
  if (paymentHash !== undefined && hash.toLowerCase() !== paymentHash.toLowerCase()) {
    mismatch('payment hash differs from the one returned on init')
  }
}
