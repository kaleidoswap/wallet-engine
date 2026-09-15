/** Shared newest-first filtering and pagination for adapter transaction lists. */

import type { Layer, TransactionFilter, UnifiedTransaction } from '../types/base'
import { isBtcAssetId } from './asset-id'

/**
 * Layers whose asset IS bitcoin, whatever the protocol calls it there.
 *
 * Every adapter but Liquid labels its bitcoin row `id: 'BTC'`. Liquid labels
 * L-BTC with the policy-asset hex, which is the more informative answer and
 * should stay — so the match has to know that an L-BTC row is bitcoin rather
 * than requiring the caller to know the policy asset of the network they did
 * not ask about.
 */
const BITCOIN_LAYERS: ReadonlySet<Layer> = new Set<Layer>([
  'BTC_L1',
  'BTC_LN',
  'BTC_ARKADE',
  'BTC_SPARK',
  'BTC_LIQUID',
])

/**
 * Does this row's asset answer to `wanted`?
 *
 * An exact id always matches, so a caller who knows the policy asset can still
 * filter on it. `'BTC'` — the engine's protocol-neutral bitcoin id, per
 * `isBtcAssetId` — additionally matches any row on a bitcoin layer.
 *
 * Without that, `listTransactions({ asset: 'BTC' })` returned Liquid's L-BTC
 * rows only while the adapter could NOT identify the policy asset (the
 * fallback labels them `'BTC'`) and dropped them once it could — the same
 * query answering differently depending on the adapter's internal state (#73).
 */
function assetMatches(asset: UnifiedTransaction['asset'], wanted: string): boolean {
  if (asset?.id === wanted) return true
  if (!isBtcAssetId(wanted)) return false
  return isBtcAssetId(asset?.id) || (asset?.layer != null && BITCOIN_LAYERS.has(asset.layer))
}

/** Apply predicates, sort newest-first, then slice by offset/limit. */
export function applyTransactionFilter(
  txs: UnifiedTransaction[],
  filter?: TransactionFilter,
): UnifiedTransaction[] {
  const ordered = [...txs].sort((a, b) => b.timestamp - a.timestamp)
  if (!filter) return ordered

  const matched = ordered.filter((tx) => {
    if (filter.asset && !assetMatches(tx.asset, filter.asset)) return false
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
