/**
 * RgbCore
 * -------
 * Pure, transport-agnostic translation helpers shared by every RGB-backed
 * adapter: the node-backed `RlnWdkAdapter` (RGB over an rgb-lightning-node, with
 * Lightning) and the local `RgbLibWdkAdapter` (RGB-L1 over rgb-lib, no Lightning).
 *
 * Only the BACKING differs between those two — the shape of an RGB asset, a
 * balance, and a status are identical. Keeping the mapping here is the single
 * source of truth so the two adapters cannot drift (the native adapters
 * predate this and are intentionally left untouched).
 *
 * Everything here is pure: no I/O, no SDK calls, no `this`.
 */

import type { ProtocolType, Layer, UnifiedAsset, AssetBalance, TransactionStatus } from '../../types/base'

/**
 * What differs between the two RGB backings: the node-backed `RGB` adapter has
 * Lightning + swaps and lists assets on the RGB-LN layer; the local rgb-lib
 * `RGB_L1` adapter is on-chain only. Everything else about the asset/balance
 * mapping is identical, so the adapters pass their profile and share the rest.
 */
export interface RgbProfile {
  protocol: ProtocolType
  /** Layer reported for RGB asset balances (RGB_LN for the node, RGB_L1 for rgb-lib). */
  assetLayer: Layer
  supportsLightning: boolean
  supportsSwaps: boolean
}

/** Node-backed RGB over an rgb-lightning-node (Lightning + swaps). */
export const RLN_PROFILE: RgbProfile = {
  protocol: 'RGB_LN',
  assetLayer: 'RGB_LN',
  supportsLightning: true,
  supportsSwaps: true,
}

/** Local rgb-lib RGB-L1 (on-chain only, no Lightning/swaps). */
export const RGB_L1_PROFILE: RgbProfile = {
  protocol: 'RGB_L1',
  assetLayer: 'RGB_L1',
  supportsLightning: false,
  supportsSwaps: false,
}

/** Map an RGB node/lib status string → domain TransactionStatus. */
export function mapRgbStatus(s?: string): TransactionStatus {
  const v = (s ?? '').toLowerCase()
  if (v.includes('succeed') || v.includes('settled') || v === 'paid') return 'confirmed'
  if (v.includes('fail')) return 'failed'
  return 'pending'
}

/** Build the unified BTC asset entry for an RGB wallet from its spendable total. */
export function rgbBtcAsset(total: number, profile: RgbProfile): UnifiedAsset {
  return {
    id: 'BTC',
    name: 'Bitcoin',
    ticker: 'BTC',
    precision: 8,
    protocol: profile.protocol,
    layer: 'BTC_L1',
    balance: makeBalance(total),
    capabilities: {
      canSend: true,
      canReceive: true,
      canSwap: profile.supportsSwaps,
      supportsLightning: profile.supportsLightning,
      supportsOnchain: true,
    },
  }
}

/** Map a raw RGB NIA (fungible) asset record → UnifiedAsset for the given profile. */
export function rgbNiaAsset(
  raw: {
    asset_id: string
    name?: string
    ticker?: string
    precision?: number | string
    balance?: { spendable?: number; settled?: number; future?: number }
  },
  profile: RgbProfile
): UnifiedAsset {
  return {
    id: raw.asset_id,
    name: raw.name ?? raw.ticker ?? raw.asset_id,
    ticker: raw.ticker ?? raw.asset_id?.slice(0, 6),
    precision: Number(raw.precision ?? 0),
    protocol: profile.protocol,
    layer: profile.assetLayer,
    balance: rgbAssetBalance(raw.balance),
    capabilities: {
      canSend: true,
      canReceive: true,
      canSwap: profile.supportsSwaps,
      supportsLightning: profile.supportsLightning,
      supportsOnchain: true,
    },
  }
}

/**
 * Map a raw rgb-lib Balance ({ settled, future, spendable }) → domain
 * AssetBalance. `future` is the projected total (confirmed + incoming), so it's
 * the "owned" amount; `spendable` is what can be sent right now. Uses `||` (not
 * `??`) so a present-but-zero `spendable` doesn't hide a real `settled`/`future`
 * — a just-received asset has spendable: 0 but a non-zero balance.
 */
export function rgbAssetBalance(raw?: { spendable?: number; settled?: number; future?: number }): AssetBalance {
  const b = raw ?? {}
  const settled = Number(b.settled ?? 0)
  const future = Number(b.future ?? 0)
  const spendable = Number(b.spendable ?? settled)
  const owned = future || settled || spendable || 0
  return {
    total: owned,
    available: spendable,
    pending: Math.max(0, future - settled),
    totalDisplay: String(owned),
    availableDisplay: String(spendable),
  }
}

function makeBalance(total: number): AssetBalance {
  return {
    total,
    available: total,
    pending: 0,
    totalDisplay: String(total),
    availableDisplay: String(total),
  }
}
