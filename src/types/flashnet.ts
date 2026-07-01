/**
 * Flashnet Protocol Types
 * Ported from rate-extension/src/protocols/types/flashnet.ts
 *
 * Re-exports the @flashnet/sdk types we lean on so call sites have a single
 * import surface. These are type-only re-exports — erased at compile time — so
 * the SDK-free root barrel stays runtime-clean even though it does
 * `export * from './types/flashnet'`.
 */
export type { FlashnetClient, WalletBalance, TokenBalance } from '@flashnet/sdk'
export type {
  // AMM swaps
  SimulateSwapRequest,
  SimulateSwapResponse,
  SwapResponse,
  // Multi-hop / route swaps
  SimulateRouteSwapRequest,
  SimulateRouteSwapResponse,
  ExecuteRouteSwapResponse,
  // Pools
  ListPoolsQuery,
  ListPoolsResponse,
  PoolDetailsResponse,
  PoolLiquidityResponse,
  // Swap history
  ListPoolSwapsQuery,
  ListPoolSwapsResponse,
  ListUserSwapsQuery,
  ListUserSwapsResponse,
  // Errors
  FlashnetErrorCode,
  FlashnetErrorResponseBody,
} from '@flashnet/sdk'

export type FlashnetNetwork = 'mainnet' | 'regtest'

// Mainnet and regtest share one canonical USDB token address.
export const USDB_TOKEN_ADDRESS: Record<'mainnet' | 'regtest', string> = {
  mainnet: 'btkn1xgrvjwey5ngcagvap2dzzvsy4uk8ua9x69k82dwvt5e7ef9drm9qztux87',
  regtest: 'btkn1xgrvjwey5ngcagvap2dzzvsy4uk8ua9x69k82dwvt5e7ef9drm9qztux87',
}

export const USDB_TOKEN_ADDRESS_ALIASES = [
  USDB_TOKEN_ADDRESS.mainnet,
  'btknrt1xgrvjwey5ngcagvap2dzzvsy4uk8ua9x69k82dwvt5e7ef9drm9qp48s74',
]

export const BTC_ASSET_PUBKEY =
  '020202020202020202020202020202020202020202020202020202020202020202'

export const USDB_DECIMALS = 6
export const BTC_DECIMALS = 8

export const FLASHNET_API_URL: Record<'mainnet' | 'regtest', string> = {
  mainnet: 'https://api.flashnet.xyz',
  regtest: 'https://api.amm.makebitcoingreatagain.dev',
}

export const FLASHNET_REWARDS_API_URL = 'https://rewards.flashnet.xyz'
export const FLASHNET_USDB_REWARDS_DOC_URL = 'https://docs.flashnet.xyz/usdb/rewards'
export const SPARK_BALANCES_DOC_URL = 'https://docs.spark.money/wallets/balances'

export const DEFAULT_SLIPPAGE_BPS = 500

export interface UsdbRewardTier {
  minBalance: number
  rate: number
  label: string
}

export const USDB_REWARD_TIERS: UsdbRewardTier[] = [
  { minBalance: 10, rate: 0.035, label: '3.5%' },
  { minBalance: 1_000, rate: 0.045, label: '4.5%' },
  { minBalance: 10_000, rate: 0.06, label: '6%' },
]

export function getFlashnetNetworkForSpark(
  sparkNetwork: string | null | undefined,
): FlashnetNetwork | null {
  const normalized = sparkNetwork?.trim().toLowerCase()
  if (normalized === 'mainnet') return 'mainnet'
  if (normalized === 'regtest') return 'regtest'
  return null
}

export function getFlashnetUsdbTokenAddress(network: FlashnetNetwork): string {
  return USDB_TOKEN_ADDRESS[network]
}

export function isUsdbTokenAddress(value: string | null | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return USDB_TOKEN_ADDRESS_ALIASES.some((alias) => alias.toLowerCase() === normalized)
}

export function getUsdbRewardRate(usdbBalance: number): number {
  let rate = 0
  for (const tier of USDB_REWARD_TIERS) {
    if (usdbBalance >= tier.minBalance) rate = tier.rate
  }
  return rate
}

export interface FlashnetSwapSimulation {
  amountOut: bigint
  executionPrice: number
  priceImpactPct: number
}

export interface FlashnetSwapResult {
  amountOut: bigint
  amountIn: bigint
  outboundTransferId: string
}

export interface FlashnetPool {
  lpPublicKey: string
  assetAAddress: string
  assetBAddress: string
  reserveA: bigint
  reserveB: bigint
  tvl?: number
}
