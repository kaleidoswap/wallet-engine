/**
 * Base types shared across all protocols
 * Ported from rate-extension/src/protocols/types/base.ts
 */

// Protocol names
// 'RGB_LN' = RGB over an rgb-lightning-node (BTC L1/LN + RGB L1/LN, swaps).
// 'RGB_L1' = RGB on-chain only, backed by rgb-lib locally (no Lightning).
export type ProtocolType = 'RGB_LN' | 'RGB_L1' | 'SPARK' | 'ARKADE' | 'BTC' | 'LIQUID'

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

/**
 * An asset's balance in that asset's own base units.
 *
 * These field meanings were unstated for long enough that two converters in this
 * one repository diverged on them (audit finding C-F4: the legacy RGB converters
 * emitted `total = settled, pending = future`, so a UI summing `total + pending`
 * double-counted and an unconfirmed receive was invisible). The semantics below
 * are the ones `RgbCore.rgbAssetBalance` — the shared source of truth for the WDK
 * RGB adapters — has always implemented, and that the legacy converters were
 * aligned onto in commit 5f38ec5.
 *
 * `total` and `pending` OVERLAP by design. `pending` is a *component* of `total`,
 * not an addition to it, so `total + pending` is never a meaningful figure.
 */
export interface AssetBalance {
  /**
   * Everything the wallet OWNS, including amounts not yet settled — i.e. the
   * projected balance once every pending transaction confirms. A just-received,
   * unconfirmed asset counts here.
   *
   * NOT the confirmed-only figure, and NOT `available + pending`.
   */
  total: number
  /**
   * What can be spent RIGHT NOW. Excludes unconfirmed receives and anything
   * locked. Always `<= total`.
   */
  available: number
  /**
   * The unsettled DELTA — how much of `total` has not confirmed yet. Zero for a
   * fully settled balance.
   *
   * NOT the projected total (that is `total`), and not a second bucket to add to
   * it. Producers with no notion of unconfirmed funds report 0.
   */
  pending: number
  /**
   * Owned but not spendable for a reason other than confirmation — e.g. an RGB
   * off-chain outbound capacity, or a token amount committed elsewhere. Optional
   * because most producers have no such concept. Counted inside `total`.
   */
  locked?: number

  /**
   * `total` rendered at the ASSET'S OWN precision via `formatAmount`, e.g. a
   * precision-0 asset holding 1,000,000 units renders "1000000", not "0.01000000".
   * Producers that do not know the asset's precision default to 8 (the BTC
   * convention) — which is correct for sats and wrong for everything else, so a
   * producer that CAN resolve the real precision must.
   */
  totalDisplay: string
  /** `available` rendered the same way as `totalDisplay`. */
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

/**
 * UNITS: `fromAmount`/`toAmount` are RAW base units, as with `Quote`. Both swap
 * paths reject fractional values, so display-unit callers fail loudly instead of
 * creating orders scaled by 10^precision.
 */
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
  /**
   * Per-swap token for polling status at the maker, issued once at execution. Hosts
   * must persist it alongside the swapId — the in-memory fallback does not survive
   * restarts.
   */
  accessToken?: string
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
