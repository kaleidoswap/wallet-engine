/**
 * Flashnet Protocol Types
 * Ported from rate-extension/src/protocols/types/flashnet.ts
 */

export type FlashnetNetwork = 'mainnet' | 'regtest'

export const USDB_TOKEN_ADDRESS: Record<'mainnet' | 'regtest', string> = {
  mainnet: 'btkn1xgrvjwey5ngcagvap2dzzvsy4uk8ua9x69k82dwvt5e7ef9drm9qztux87',
  regtest: 'btkn1xgrvjwey5ngcagvap2dzzvsy4uk8ua9x69k82dwvt5e7ef9drm9qztux87',
}

export const BTC_ASSET_PUBKEY = '020202020202020202020202020202020202020202020202020202020202020202'

export const USDB_DECIMALS = 6
export const BTC_DECIMALS = 8

export const DEFAULT_SLIPPAGE_BPS = 500

export function getFlashnetNetworkForSpark(
  sparkNetwork: string | null | undefined,
): FlashnetNetwork | null {
  if (sparkNetwork === 'mainnet') return 'mainnet'
  if (sparkNetwork === 'regtest') return 'regtest'
  return null
}

export function getFlashnetUsdbTokenAddress(network: FlashnetNetwork): string {
  return USDB_TOKEN_ADDRESS[network]
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
