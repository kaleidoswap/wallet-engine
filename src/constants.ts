/**
 * Neutral, dependency-free constants shared across core and adapters. Kept here so
 * core modules never import from an adapter module, which would pull adapter/SDK
 * weight into the adapter-free main barrel.
 */

/** Well-known Liquid mainnet Tether USD (USDt) asset id — the lite-mode "USD". */
export const LIQUID_USDT_ASSET_ID =
  'ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2'

/** Liquid Testnet Tether USD (USDt) asset id ("PEGx USDt Testnet"). */
export const LIQUID_TESTNET_USDT_ASSET_ID =
  'b612eb46313a2cd6ebabd8b7a8eed5696e29898b87a43bff41c94f51acef9d73'
