import type { TransactionFilter } from '../types/base'

const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_SPARK_ACTIVITY_LIMIT = 50
export const DEFAULT_SPARK_ACTIVITY_LOOKBACK_DAYS = 180

export function buildSparkActivityFilter(
  overrides: Partial<TransactionFilter> = {},
): TransactionFilter {
  return {
    limit: DEFAULT_SPARK_ACTIVITY_LIMIT,
    fromTimestamp: Date.now() - DEFAULT_SPARK_ACTIVITY_LOOKBACK_DAYS * DAY_MS,
    ...overrides,
  }
}
