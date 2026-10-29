/**
 * The Lightning fee budget a Spark send may spend on top of the invoice
 * principal. Spark's SDK selects leaves for `principal + fee`, so the budget
 * is money the wallet can lose and the spend policy must authorise it with
 * the principal (security review 2026-10-28, finding 17). Both Spark adapters
 * and `ProtocolManager` resolve it here so they cannot disagree.
 */

import { ProtocolError } from '../types/base'

/** Fee ceiling applied when a caller gives none. */
export const DEFAULT_SPARK_MAX_FEE_SATS = 1000

/** `PaymentRequest.maxFeeSats`, plus the legacy `maxFee` alias some hosts still send. */
export interface SparkFeeBudgetRequest {
  maxFeeSats?: unknown
  maxFee?: unknown
}

/**
 * Effective maximum fee for a Spark Lightning send: `maxFeeSats` (the
 * documented field), else the legacy `maxFee` alias, else the default budget.
 * A budget that is not a non-negative safe integer is refused rather than
 * coerced: an unparseable ceiling must never become "no ceiling".
 */
export function resolveSparkMaxFeeSats(request: SparkFeeBudgetRequest): number {
  const raw = request.maxFeeSats ?? request.maxFee
  if (raw == null) return DEFAULT_SPARK_MAX_FEE_SATS
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new ProtocolError(
      `Invalid maxFeeSats: ${String(raw)} (must be a non-negative integer of sats)`,
      'SPARK',
      'INVALID_AMOUNT',
    )
  }
  return raw
}
