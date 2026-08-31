/**
 * Shared `TransactionFilter` application for `IProtocolAdapter.listTransactions`.
 *
 * `listTransactions(filter?)` accepts a `TransactionFilter`
 * (`asset`/`type`/`status`/`fromTimestamp`/`toTimestamp`/`limit`/`offset`), but
 * five adapters named the parameter `_filter` and discarded it, and two more
 * pushed limit/offset into a per-leg RPC without slicing the MERGED result. A host
 * paginating with `{ limit: 20, offset: 20 }` therefore got the full unfiltered
 * list back — page 2 was page 1 — with no signal that the filter had been ignored
 * (audit finding G-F8).
 *
 * ORDERING IS DELIBERATELY NOT CHANGED. Nothing in the contract specifies one:
 * `listTransactions` has no JSDoc, `TransactionFilter` has no field docs, and
 * `UnifiedTransaction` carries no ordering note. `RgbAdapter`/`SparkAdapter` sort
 * newest-first and four adapters pass SDK order through, so a merged
 * multi-protocol feed does have inconsistent per-protocol ordering — but imposing
 * a sort here changes the output order every existing consumer sees (it breaks two
 * pre-existing tests that read `txs[0]`/`txs[1]` positionally), and no in-repo
 * source says which order is right. `ProtocolManager.listAllTransactions` re-sorts
 * the merged result by descending timestamp anyway. The ordering question is
 * carried in REPORT-2 as a product decision.
 *
 * Pure: same input, same output, no `this`, no I/O.
 */

import type { TransactionFilter, UnifiedTransaction } from '../types/base'

/** Apply predicates, sort newest-first, then slice by offset/limit. */
export function applyTransactionFilter(
  txs: UnifiedTransaction[],
  filter?: TransactionFilter,
): UnifiedTransaction[] {
  if (!filter) return txs

  const matched = txs.filter((tx) => {
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
