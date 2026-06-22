/**
 * RGB Protocol Types
 * Ported from rate-extension/src/protocols/types/rgb.ts
 */

import { BaseProtocolConfig } from '../adapters/IProtocolAdapter'

/**
 * How the RGB Lightning Node (RLN) is reached.
 *  - "http": direct HTTP RPC to `nodeUrl` (optional Biscuit/JWT auth).
 *  - "nwc":  Nostr Wallet Connect — the node is reached over a relay using a
 *            `nostr+walletconnect://` connection string (`nwcUri`). The maker
 *            stays a separate optional HTTP concern regardless of transport.
 */
export type RgbTransport = 'http' | 'nwc'

export interface RgbConfig extends BaseProtocolConfig {
  protocol: 'RGB'
  makerUrl: string // Kaleidoswap maker URL
  /** Node transport. Defaults to "http" when omitted. */
  transport?: RgbTransport
  nodeUrl?: string // RGB Lightning node URL (required for transport "http")
  jwt?: string // JWT token for node authentication (optional)
  apiKey?: string // API key for maker (optional)
  /**
   * `nostr+walletconnect://` connection string. Required for transport "nwc".
   * Sensitive (carries the client secret) — encrypted at rest, never logged.
   */
  nwcUri?: string
}

export interface RgbAssetMetadata {
  assetId: string
  contractId?: string
  schema: 'Nia' | 'Cfa' | string
  issuedSupply: number
  timestamp: number
  addedAt: number
  details?: string
}

export interface RgbChannel {
  channelId: string
  peerPubkey: string
  capacitySat: number
  localBalanceSat: number
  remoteBalanceSat: number
  isActive: boolean
  isUsable: boolean
  assetId?: string
  assetLocalAmount?: number
  assetRemoteAmount?: number
}

export interface RgbInvoice {
  invoice: string
  recipientId: string
  assetId: string
  expiresAt: number
}

export interface RgbTransfer {
  txid?: string
  recipientId: string
  assetId: string
  amount: number
  status: 'pending' | 'confirmed' | 'failed'
  timestamp: number
}

export interface KaleidoswapQuote {
  rfqId: string
  fromAsset: string
  fromAmount: number
  toAsset: string
  toAmount: number
  price: number
  fee: {
    baseFee: number
    variableFee: number
    feeRate: number
    finalFee: number
    feeAsset: string
    feeAssetPrecision: number
  }
  timestamp: number
  expiresAt: number
}

export interface RgbNodeInfo {
  pubkey: string
  alias?: string
  network: string
  blockHeight: number
  syncStatus?: {
    synced: boolean
    progress: number
  }
  version?: string
}

export interface TradingPair {
  id?: string
  baseAsset: string
  baseAssetId: string
  basePrecision: number
  quoteAsset: string
  quoteAssetId: string
  quotePrecision: number
  isActive: boolean
  minBaseOrderSize: number
  maxBaseOrderSize: number
  minQuoteOrderSize: number
  maxQuoteOrderSize: number
}
