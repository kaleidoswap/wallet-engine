/**
 * Route preference + rail priority
 * --------------------------------
 * A unified payment URI (BIP21/BIP321) can carry several rails at once — a
 * BOLT12 offer, a BOLT11 invoice, Spark/Arkade addresses, an RGB invoice, a
 * Liquid address, an on-chain address. When more than one is payable, the
 * engine has to pick. This module is the *data* that drives that choice:
 *
 *  - a DEFAULT rail ordering (Lightning-first), used when the user expresses no
 *    preference, and
 *  - a `RoutePreference` the host can supply: an ordered list of layers, with
 *    optional per-asset overrides.
 *
 * Pure + dependency-free; the router consumes it.
 */

import { Layer } from '../types/base'
import { DestinationKind } from './destination'

/** A concrete payment rail, i.e. which embedded method pays the destination. */
export type Rail = 'lno' | 'lightning' | 'spark' | 'ark' | 'rgb' | 'liquid' | 'onchain'

/**
 * Default rail priority — **Lightning-first**: BOLT12 offer, then BOLT11, then
 * the off-chain instant rails (Spark, Arkade), then on-chain (RGB-L1, Liquid,
 * bare BTC). Used when no user preference applies. Lower index = higher priority.
 */
export const DEFAULT_RAIL_ORDER: readonly Rail[] = [
  'lno',
  'lightning',
  'spark',
  'ark',
  'rgb',
  'liquid',
  'onchain',
]

/**
 * The user's routing preference. `layers` is a global ranking (highest first);
 * `perAsset` overrides it for a specific asset id (e.g. prefer Liquid for USDt,
 * Lightning for BTC). When neither resolves a tie, the DEFAULT rail order wins.
 */
export interface RoutePreference {
  /** Global ordered layer ranking, highest priority first. */
  layers?: Layer[]
  /** Per-asset-id ordered layer rankings, overriding `layers` for that asset. */
  perAsset?: Record<string, Layer[]>
}

/** Resolve the effective ordered layer list for a given asset id (if any). */
export function layerPreferenceFor(pref: RoutePreference | undefined, assetId?: string): Layer[] | undefined {
  if (!pref) return undefined
  if (assetId && pref.perAsset && pref.perAsset[assetId]) return pref.perAsset[assetId]
  return pref.layers
}

const NOT_RANKED = Number.MAX_SAFE_INTEGER

function indexOrLast<T>(list: readonly T[] | undefined, item: T): number {
  if (!list) return NOT_RANKED
  const i = list.indexOf(item)
  return i === -1 ? NOT_RANKED : i
}

/**
 * Comparator for two rail/layer routes given a resolved layer preference.
 * Primary key: the user's layer ranking (if the route's layer appears in it).
 * Tiebreak: the default rail ordering. Routes neither side ranks compare equal.
 */
export function compareByPreference(
  a: { rail: Rail; layer: Layer | null },
  b: { rail: Rail; layer: Layer | null },
  layerPref?: Layer[]
): number {
  if (layerPref && layerPref.length) {
    const ai = a.layer ? indexOrLast(layerPref, a.layer) : NOT_RANKED
    const bi = b.layer ? indexOrLast(layerPref, b.layer) : NOT_RANKED
    if (ai !== bi) return ai - bi
  }
  return indexOrLast(DEFAULT_RAIL_ORDER, a.rail) - indexOrLast(DEFAULT_RAIL_ORDER, b.rail)
}

/** Map a single-destination classification kind → its rail (for the non-URI path). */
export function railOfKind(kind: DestinationKind): Rail {
  switch (kind) {
    case 'BOLT12':
      return 'lno'
    case 'BOLT11':
    case 'LN_ADDRESS':
      return 'lightning'
    case 'SPARK':
      return 'spark'
    case 'ARKADE':
      return 'ark'
    case 'RGB_INVOICE':
      return 'rgb'
    case 'LIQUID':
      return 'liquid'
    case 'BTC_ONCHAIN':
    case 'BIP21':
    default:
      return 'onchain'
  }
}
