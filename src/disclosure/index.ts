/**
 * Disclosure Level (Lite / Advanced)
 * ----------------------------------
 * Not a code fork — one setting controlling how much the UI reveals and how much
 * the auto-router decides. The engine is identical underneath, and this module is
 * the single source of truth for what each level exposes, so neither apps nor
 * adapters branch on "mode" ad-hoc. The default is set at wallet creation but is
 * reversible in settings.
 */

import { ProtocolType, UnifiedAsset } from '../types/base'
import { LIQUID_USDT_ASSET_ID } from '../constants'

export type DisclosureLevel = 'lite' | 'advanced'

export interface DisclosurePolicy {
  level: DisclosureLevel
  /** Show the network/layer behind balances and the network selector. */
  showNetworks: boolean
  /** Let the user pick the send route (vs. auto-router picks `.best`). */
  showRouteSelector: boolean
  /** Expose Lightning channel / LSPS1 management. */
  showChannelManagement: boolean
  /** Expose experimental/advanced features (raw UTXOs, node config, etc.). */
  showExperimental: boolean
  /** Show raw protocol/asset ids vs. friendly tickers only. */
  showRawIds: boolean
}

export function policyFor(level: DisclosureLevel): DisclosurePolicy {
  if (level === 'advanced') {
    return {
      level,
      showNetworks: true,
      showRouteSelector: true,
      showChannelManagement: true,
      showExperimental: true,
      showRawIds: true,
    }
  }
  return {
    level: 'lite',
    showNetworks: false,
    showRouteSelector: false,
    showChannelManagement: false,
    showExperimental: false,
    showRawIds: false,
  }
}

/**
 * Lite-mode "USD" = USDt on Liquid (locked product decision), used to
 * relabel/aggregate the user-facing "USD" balance.
 */
export const LITE_USD = {
  protocol: 'LIQUID' as ProtocolType,
  assetId: LIQUID_USDT_ASSET_ID,
  displayTicker: 'USD',
} as const

/** Buckets a unified asset into the three lite-mode user-facing buckets. */
export type LiteBucket = 'BTC' | 'USD' | 'OTHER'

export function liteBucketOf(asset: UnifiedAsset): LiteBucket {
  // Bucket by adapter-assigned identity only: ids and layers come from our
  // adapters, while tickers are issuer-controlled, so a scam token tickered "BTC"
  // must never inflate displayed totals. BTC_LIQUID marks the Liquid policy asset.
  if (asset.id === 'BTC' || asset.layer === 'BTC_LIQUID') return 'BTC'
  if (asset.id === LITE_USD.assetId) return 'USD'
  return 'OTHER'
}

/**
 * Aggregate per-protocol assets into the lite-mode view — one BTC number, one USD
 * number, and any others — hiding which network each lives on. Callers should
 * surface spendability constraints just-in-time; this only aggregates display
 * balances.
 */
export interface LiteBalances {
  btc: number
  usd: number
  other: UnifiedAsset[]
}

export function aggregateForLite(assets: UnifiedAsset[]): LiteBalances {
  let btc = 0
  let usd = 0
  const other: UnifiedAsset[] = []
  for (const a of assets) {
    const bucket = liteBucketOf(a)
    if (bucket === 'BTC') btc += a.balance.total
    else if (bucket === 'USD') usd += a.balance.total
    else other.push(a)
  }
  return { btc, usd, other }
}
