/**
 * Protocol Adapter Interface
 * All protocol implementations must implement this interface.
 *
 * Canonical contract: this is the single source of truth shared by every host
 * (rate-extension, rate mobile, desktop). Hosts that ship their own adapters
 * implement this interface; they must NOT redeclare it. See the wallet-engine
 * integration spec (A1/A2).
 */

import {
  ProtocolType,
  Layer,
  NodeInfo,
  UnifiedAsset,
  UnifiedTransaction,
  InvoiceRequest,
  Invoice,
  DecodedInvoice,
  KeysendRequest,
  PaymentRequest,
  PaymentResult,
  PaymentStatus,
  Address,
  ConnectionInfo,
  TransactionFilter,
  QuoteRequest,
  Quote,
  SwapResult,
} from '../types/base'
import type { ProtocolCapability } from '../capabilities/operations'
import type { RgbConfig } from '../types/rgb'
import type { SparkConfig } from '../types/spark'
import type { ArkadeConfig } from '../types/arkade'

/**
 * Base configuration for all protocols.
 */
export interface BaseProtocolConfig {
  protocol: ProtocolType
  network?: 'mainnet' | 'testnet' | 'regtest' | 'signet'
}

/**
 * Union of all protocol-specific configurations. Each adapter owns its own
 * config shape (e.g. RGB carries nodeUrl/makerUrl and no mnemonic; Spark/Arkade
 * carry a mnemonic) — the contract must not assume a single shape.
 */
export type ProtocolConfig = RgbConfig | SparkConfig | ArkadeConfig

export interface IProtocolAdapter {
  // ========================================================================
  // Protocol Metadata
  // ========================================================================

  readonly protocolName: ProtocolType
  readonly supportedLayers: Layer[]
  readonly version: string

  /**
   * Native operations this adapter supports. Static — available before the
   * adapter connects — so the UI can gate actions without per-call-site
   * network checks.
   */
  readonly capabilities: readonly ProtocolCapability[]

  // ========================================================================
  // Connection Management
  // ========================================================================

  connect(config: ProtocolConfig): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  getConnectionInfo(): Promise<ConnectionInfo>

  // ========================================================================
  // Asset Operations
  // ========================================================================

  listAssets(): Promise<UnifiedAsset[]>
  getAsset(assetId: string): Promise<UnifiedAsset>
  getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']>
  refreshBalances(): Promise<void>

  // ========================================================================
  // Transaction Operations
  // ========================================================================

  listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]>
  /** @param assetId - Required for RGB protocol (transfers are per-asset) */
  getTransaction(txId: string, assetId?: string): Promise<UnifiedTransaction>

  // ========================================================================
  // Payment Operations
  // ========================================================================

  createInvoice(request: InvoiceRequest): Promise<Invoice>
  decodeInvoice(invoice: string): Promise<DecodedInvoice>
  sendPayment(request: PaymentRequest): Promise<PaymentResult>
  /**
   * Send a spontaneous Lightning keysend payment.
   * Optional — not every protocol backend exposes a keysend primitive.
   */
  payKeysend?(request: KeysendRequest): Promise<PaymentResult>
  getPaymentStatus(paymentHash: string): Promise<PaymentStatus>

  // ========================================================================
  // Address Operations
  // ========================================================================

  /** @param assetId - Optional asset ID (for multi-asset protocols) */
  getReceiveAddress(assetId?: string): Promise<Address>

  // ========================================================================
  // Node & Balance Operations
  // ========================================================================

  /** Get node info (pubkey, channels, local_balance_sat, etc.). */
  getNodeInfo(): Promise<NodeInfo>
  getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }>
  /** Returns empty array for protocols without channels (e.g. Spark). */
  listChannels(): Promise<unknown[]>
  listPayments(): Promise<unknown>
  listTransfers(options?: { asset_id?: string }): Promise<unknown>

  // ========================================================================
  // Protocol-Specific Send/Receive (Optional)
  // ========================================================================

  /** Create an RGB on-chain invoice (RGB only). */
  createRgbInvoice?(params: Record<string, unknown>): Promise<unknown>
  /** Decode an RGB invoice (RGB only). */
  decodeRgbInvoice?(params: Record<string, unknown>): Promise<unknown>
  /** Create colorable (uncolored) UTXOs for receiving RGB assets (RGB only). */
  createRgbUtxos?(params: {
    num?: number
    size?: number
    feeRate?: number
    upTo?: boolean
  }): Promise<{ success: boolean }>
  /** List the node's unspent outputs with their RGB allocations (RGB only). */
  listRgbUnspents?(): Promise<{
    unspents: Array<{
      utxo: { outpoint: string; btc_amount: number; colorable: boolean }
      rgb_allocations: Array<{
        asset_id?: string | null
        assignment: unknown
        settled: boolean
      }>
    }>
  }>
  /** Estimate the on-chain fee rate for a confirmation target (RGB only). */
  estimateRgbFee?(blocks: number): Promise<{ fee_rate: number }>
  /** Detailed BTC balance with vanilla / colored split (RGB only). */
  getRgbDetailedBalance?(): Promise<{
    vanilla: { settled: number; future: number; spendable: number }
    colored: { settled: number; future: number; spendable: number }
  }>
  getInvoiceStatus?(params: { invoice: string }): Promise<unknown>
  /** Send an RGB asset on-chain (RGB only). */
  sendAsset?(params: Record<string, unknown>): Promise<unknown>
  sendBtcOnchain?(params: { address: string; amount: number; feeRate?: number }): Promise<unknown>
  /**
   * Broadcast a raw, fully-signed network transaction (hex) through the
   * adapter's node. Optional — callers fall back to a public broadcaster when
   * absent.
   */
  broadcastTransaction?(txHex: string): Promise<{ txid: string }>
  /**
   * Sign a PSBT (BIP 174) using wallet-owned inputs. Implementations MUST parse
   * before any confirmation UI, sign only inputs matching a wallet key, and
   * return { psbt: originalHex, unchanged: true } when no owned inputs exist.
   */
  signPsbt?(psbtHex: string): Promise<{ psbt: string; unchanged: boolean }>
  /**
   * Sign an arbitrary message using the wallet's Lightning identity key.
   * Returns an LND-style zbase32-encoded recoverable ECDSA signature.
   */
  signMessage?(message: string): Promise<string>
  /**
   * Verify an LND-style zbase32 signature and recover the signing pubkey.
   * Returns the hex-encoded compressed public key of the signer.
   */
  verifyMessage?(message: string, signature: string): Promise<string>

  // ========================================================================
  // Spark-Specific Operations (Optional)
  // ========================================================================

  /** Create a Spark-native invoice (Spark only). */
  createSparkInvoice?(request: InvoiceRequest): Promise<Invoice>
  /**
   * Auto-claim a Spark L1 (single-use) deposit. Returns `awaiting` while no
   * UTXO is confirmed yet.
   */
  claimSparkL1Deposit?(params: { address: string }): Promise<{
    status: 'awaiting' | 'claimed' | 'error'
    txids?: string[]
    error?: string
  }>
  /**
   * Sweep every previously-generated single-use Spark deposit address that
   * still has unclaimed UTXOs and credit them to the wallet.
   */
  sweepSparkL1Deposits?(): Promise<{
    addressesChecked: number
    claimedTxids: string[]
    errors: string[]
  }>

  // ========================================================================
  // Arkade-Specific Operations (Optional)
  // ========================================================================

  /**
   * Create a Lightning invoice that pays into Arkade via a Boltz reverse swap.
   * Requires a positive `request.amount`.
   */
  createArkadeLightningInvoice?(request: InvoiceRequest): Promise<Invoice>
  /** List virtual transaction outputs (Arkade only). */
  getVtxos?(): Promise<Record<string, unknown>[]>
  /** List boarding UTXOs (Arkade only). */
  getBoardingUtxos?(): Promise<Record<string, unknown>[]>
  /** Onboard funds to Arkade (Arkade only). */
  onboard?(): Promise<{ txid: string }>
  /** Offboard funds from Arkade to on-chain (Arkade only). */
  offboard?(address: string, amount?: number): Promise<{ txid: string }>

  // ========================================================================
  // Swap Operations (Optional)
  // ========================================================================

  supportsSwaps(): boolean
  getSwapQuote?(request: QuoteRequest): Promise<Quote>
  executeSwap?(quote: Quote): Promise<SwapResult>
  getSwapStatus?(swapId: string): Promise<SwapResult>

  // ========================================================================
  // Generic Extension
  // ========================================================================

  /**
   * Generic escape hatch used by some WDK adapters. rate-extension's adapters
   * use typed methods instead and do not implement this — kept optional.
   */
  executeProtocolOperation?(operation: string, params: unknown): Promise<unknown>
}

export interface IProtocolAdapterFactory {
  createAdapter(protocol: ProtocolType): IProtocolAdapter
  getSupportedProtocols(): ProtocolType[]
}

export class ProtocolAdapterRegistry {
  private adapters: Map<ProtocolType, IProtocolAdapter> = new Map()

  register(adapter: IProtocolAdapter): void {
    this.adapters.set(adapter.protocolName, adapter)
  }

  unregister(protocol: ProtocolType): void {
    this.adapters.delete(protocol)
  }

  get(protocol: ProtocolType): IProtocolAdapter | undefined {
    return this.adapters.get(protocol)
  }

  getAll(): IProtocolAdapter[] {
    return Array.from(this.adapters.values())
  }

  has(protocol: ProtocolType): boolean {
    return this.adapters.has(protocol)
  }

  getSupportedProtocols(): ProtocolType[] {
    return Array.from(this.adapters.keys())
  }
}
