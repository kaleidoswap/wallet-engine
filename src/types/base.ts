/**
 * Base types shared across all protocols
 * Ported from rate-extension/src/protocols/types/base.ts
 */

// Protocol names
export type ProtocolType = 'RGB' | 'SPARK' | 'ARKADE' | 'BTC' | 'LIQUID'

// Layer types
export type Layer =
  | 'BTC_L1'          // Bitcoin onchain
  | 'BTC_LN'          // Bitcoin Lightning
  | 'BTC_ARKADE'      // Bitcoin Arkade
  | 'BTC_SPARK'       // Bitcoin Spark
  | 'BTC_LIQUID'      // L-BTC on Liquid
  | 'RGB_L1'          // RGB onchain
  | 'RGB_LN'          // RGB Lightning
  | 'SPARK_SPARK'     // Spark protocol
  | 'ARKADE_ARKADE'   // Arkade protocol
  | 'LIQUID_ASSET'    // Liquid asset (e.g. USDt on Liquid — lite-mode "USD")

// Node info returned by adapters. Each protocol returns its own SDK's shape;
// these are the fields the manager/UI read in common.
export interface NodeInfo {
  pubkey?: string
  local_balance_sat?: number
  outbound_balance_msat?: number
  num_channels?: number
  [key: string]: unknown
}

// Asset interface - unified across all protocols
export interface UnifiedAsset {
  id: string
  name: string
  ticker: string
  precision: number

  protocol: ProtocolType
  layer: Layer

  balance: AssetBalance

  icon?: string
  color?: string

  capabilities: AssetCapabilities

  metadata?: Record<string, any>
}

export interface AssetBalance {
  total: number
  available: number
  pending: number
  locked?: number

  totalDisplay: string
  availableDisplay: string
}

export interface RgbAssetBalance extends AssetBalance {
  settled: number
  future: number
  spendable: number
  offchain_outbound: number
  offchain_inbound: number
}

export interface LightningChannel {
  channel_id: string
  ready?: boolean
  is_usable?: boolean
  asset_id?: string
  asset_local_amount?: number
  asset_remote_amount?: number
  next_outbound_htlc_limit_msat?: number
  local_balance_msat?: number
  [key: string]: unknown
}

export interface AssetCapabilities {
  canSend: boolean
  canReceive: boolean
  canSwap: boolean
  supportsLightning: boolean
  supportsOnchain: boolean
}

export interface UnifiedTransaction {
  id: string
  type: TransactionType
  status: TransactionStatus
  timestamp: number

  amount: number
  amountDisplay: string
  fee?: number
  feeDisplay?: string

  asset: UnifiedAsset

  from?: string
  to?: string

  protocolData?: Record<string, any>
}

export type TransactionType =
  | 'send'
  | 'receive'
  | 'swap'
  | 'channel_open'
  | 'channel_close'

export type TransactionStatus =
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'cancelled'

export interface InvoiceRequest {
  amount?: number
  asset?: string
  assetAmount?: number
  description?: string
  expirySeconds?: number
  /** Optional target layer when a protocol can receive on more than one (e.g. Spark: BTC_LN vs SPARK_SPARK). */
  layer?: Layer
}

export interface Invoice {
  invoice: string
  paymentHash: string
  amount?: number
  expiresAt: number
  description?: string
}

export interface DecodedInvoice {
  paymentHash: string
  amount?: number
  amountMsat?: number
  description?: string
  expiresAt: number
  destination: string
  asset?: string
  asset_id?: string
  asset_amount?: number
  payment_hash?: string
  amount_msat?: number
  expires_at?: number
  payee_pubkey?: string
}

export interface PaymentRequest {
  invoice: string
  amount?: number
  /** Cap on routing fee for Lightning sends (sats). Some protocols (Spark) require it. */
  maxFeeSats?: number
}

export interface KeysendRequest {
  pubkey: string
  amount: number // In msat, matching NIP-47 pay_keysend
  assetId?: string
  assetAmount?: number
}

export interface PaymentResult {
  paymentHash: string
  txid?: string
  preimage?: string
  amount: number
  fee: number
  status: TransactionStatus
  timestamp: number
}

export interface PaymentStatus {
  paymentHash: string
  status: TransactionStatus
  amount?: number
  fee?: number
  timestamp?: number
  error?: string
}

export interface Address {
  address: string
  format: AddressFormat
  asset?: string
  qrCode?: string
}

export type AddressFormat =
  | 'BTC_ADDRESS'
  | 'BOLT11'
  | 'BOLT12'
  | 'RGB_INVOICE'
  | 'SPARK_ADDRESS'
  | 'ARKADE_ADDRESS'
  | 'LIQUID_ADDRESS'

export interface ConnectionInfo {
  protocol: ProtocolType
  connected: boolean
  nodeId?: string
  network?: string
  blockHeight?: number
  syncStatus?: SyncStatus
}

export interface SyncStatus {
  synced: boolean
  progress?: number
  blockHeight?: number
  targetHeight?: number
}

export interface TransactionFilter {
  asset?: string
  type?: TransactionType
  status?: TransactionStatus
  fromTimestamp?: number
  toTimestamp?: number
  limit?: number
  offset?: number
}

export interface QuoteRequest {
  fromAsset: string
  toAsset: string
  fromAmount?: number
  toAmount?: number
}

export interface Quote {
  id: string
  fromAsset: string
  fromAmount: number
  toAsset: string
  toAmount: number
  price: number
  fee: QuoteFee
  expiresAt: number
  provider?: string
}

export interface QuoteFee {
  amount: number
  asset: string
  breakdown?: {
    baseFee: number
    variableFee: number
    networkFee: number
  }
}

export interface SwapResult {
  swapId: string
  paymentHash?: string
  status: TransactionStatus
  quote: Quote
  timestamp: number
}

// Error codes
export const ErrorCode = {
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode]

// Error types
export class ProtocolError extends Error {
  constructor(
    message: string,
    public protocol: ProtocolType,
    public code?: string,
    public details?: unknown
  ) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export class ConnectionError extends ProtocolError {
  constructor(message: string, protocol: ProtocolType, details?: unknown) {
    super(message, protocol, ErrorCode.CONNECTION_ERROR, details)
    this.name = 'ConnectionError'
  }
}

export class InsufficientBalanceError extends ProtocolError {
  constructor(message: string, protocol: ProtocolType, required: number, available: number) {
    super(message, protocol, ErrorCode.INSUFFICIENT_BALANCE, { required, available })
    this.name = 'InsufficientBalanceError'
  }
}

export class CapabilityError extends ProtocolError {
  constructor(message: string, protocol: ProtocolType, details?: unknown) {
    super(message, protocol, ErrorCode.NOT_SUPPORTED, details)
    this.name = 'CapabilityError'
  }
}

export class ConfigurationError extends ProtocolError {
  constructor(message: string, protocol: ProtocolType, details?: unknown) {
    super(message, protocol, ErrorCode.NOT_CONFIGURED, details)
    this.name = 'ConfigurationError'
  }
}

export class ValidationError extends ProtocolError {
  constructor(message: string, protocol: ProtocolType, details?: unknown) {
    super(message, protocol, ErrorCode.VALIDATION_ERROR, details)
    this.name = 'ValidationError'
  }
}
