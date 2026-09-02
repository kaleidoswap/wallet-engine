/** Shared newest-first filtering and pagination for adapter transaction lists. */

import type { TransactionFilter, UnifiedTransaction } from '../types/base'

/** Apply predicates, sort newest-first, then slice by offset/limit. */
export function applyTransactionFilter(
  txs: UnifiedTransaction[],
  filter?: TransactionFilter,
): UnifiedTransaction[] {
  const ordered = [...txs].sort((a, b) => b.timestamp - a.timestamp)
  if (!filter) return ordered

  const matched = ordered.filter((tx) => {
    if (filter.asset && tx.asset?.id !== filter.asset) return false
    if (filter.type && tx.type !== filter.type) return false
    if (filter.status && tx.status !== filter.status) return false
    if (filter.fromTimestamp && tx.timestamp < filter.fromTimestamp) return false
    if (filter.toTimestamp && tx.timestamp > filter.toTimestamp) return false
    return true
  })

  const offset = filter.offset && filter.offset > 0 ? filter.offset : 0
  if (offset === 0 && filter.limit == null) return matched
  const end = filter.limit != null && filter.limit >= 0 ? offset + filter.limit : undefined
  return matched.slice(offset, end)
}
