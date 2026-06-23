/**
 * Neutral, dependency-free constants shared across core (router, disclosure)
 * and adapters. Kept here so core modules never import from an adapter module
 * (which would pull adapter/SDK weight into the adapter-free main barrel).
 */

/** Well-known Liquid mainnet Tether USD (USDt) asset id — the lite-mode "USD". */
export const LIQUID_USDT_ASSET_ID =
  'ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2'
