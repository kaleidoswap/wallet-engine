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

import type { UnifiedAsset, AssetBalance, TransactionStatus } from '../../types/base'

/** Map an RGB node/lib status string → domain TransactionStatus. */
export function mapRgbStatus(s?: string): TransactionStatus {
  const v = (s ?? '').toLowerCase()
  if (v.includes('succeed') || v.includes('settled') || v === 'paid') return 'confirmed'
  if (v.includes('fail')) return 'failed'
  return 'pending'
}

/** Build the unified BTC asset entry for an RGB wallet from its spendable total. */
export function rgbBtcAsset(total: number): UnifiedAsset {
  return {
    id: 'BTC',
    name: 'Bitcoin',
    ticker: 'BTC',
    precision: 8,
    protocol: 'RGB',
    layer: 'BTC_L1',
    balance: makeBalance(total),
    capabilities: {
      canSend: true,
      canReceive: true,
      canSwap: true,
      supportsLightning: true,
      supportsOnchain: true,
    },
  }
}

/**
 * Map a raw RGB NIA (fungible) asset record → UnifiedAsset.
 * `layer`/`capabilities` default to the node-backed (RGB-LN) profile; the
 * RGB-L1 adapter overrides them via `overrides` since it has no Lightning.
 */
export function rgbNiaAsset(
  raw: {
    asset_id: string
    name?: string
    ticker?: string
    precision?: number | string
    balance?: { spendable?: number; settled?: number; future?: number }
  },
  overrides?: { layer?: UnifiedAsset['layer']; capabilities?: Partial<UnifiedAsset['capabilities']> }
): UnifiedAsset {
  const bal = raw.balance ?? {}
  const total = Number(bal.spendable ?? bal.settled ?? 0)
  return {
    id: raw.asset_id,
    name: raw.name ?? raw.ticker ?? raw.asset_id,
    ticker: raw.ticker ?? raw.asset_id?.slice(0, 6),
    precision: Number(raw.precision ?? 0),
    protocol: 'RGB',
    layer: overrides?.layer ?? 'RGB_LN',
    balance: makeBalance(total),
    capabilities: {
      canSend: true,
      canReceive: true,
      canSwap: true,
      supportsLightning: true,
      supportsOnchain: true,
      ...overrides?.capabilities,
    },
  }
}

/** Map a raw RGB balance record → domain AssetBalance. */
export function rgbAssetBalance(raw?: { spendable?: number; settled?: number; future?: number }): AssetBalance {
  const b = raw ?? {}
  const total = Number(b.spendable ?? b.settled ?? 0)
  return { ...makeBalance(total), pending: Number(b.future ?? 0) }
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
