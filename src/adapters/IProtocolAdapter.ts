/**
 * Protocol Adapter Interface
 * All protocol implementations must implement this interface.
 *
 * This is the SINGLE SOURCE OF TRUTH for the adapter contract. It is a superset
 * of the older "ported" interface: it adds the required `capabilities` field,
 * `NodeInfo` typing, `payKeysend`, PSBT/message signing, RGB UTXO/fee/detailed
 * -balance methods, Spark deposit-claim methods, and Arkade onboarding methods,
 * while keeping the optional `executeProtocolOperation` generic escape hatch
 * used by the WDK adapters. rate-extension consumes this definition directly
 * instead of maintaining its own copy.
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
import type { RgbConfig } from '../types/rgb'
import type { SparkConfig } from '../types/spark'
import type { ArkadeConfig } from '../types/arkade'
import type { ProtocolCapability } from '../protocol-capabilities'

/**
 * Base configuration shared by all protocols.
 */
export interface BaseProtocolConfig {
  protocol: ProtocolType
  network?: 'mainnet' | 'testnet' | 'regtest' | 'signet'
}

/**
 * Union of all protocol-specific configurations. Each adapter owns its own
 * config shape (RGB is remote/NWC and mnemonic-less; Spark/Arkade are
 * mnemonic-based). `BaseProtocolConfig` keeps the union open for the
 * WDK-backed adapters (RLN/Liquid) that declare their own config types.
 */
export type ProtocolConfig = RgbConfig | SparkConfig | ArkadeConfig | BaseProtocolConfig

export interface IProtocolAdapter {
  // ========================================================================
  // Protocol Metadata
  // ========================================================================

  readonly protocolName: ProtocolType
  readonly supportedLayers: Layer[]
  readonly version: string

  /**
   * Native operations this adapter supports (GL #68). Static — available
   * before the adapter connects — so the UI can gate actions without
   * per-call-site network checks.
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
   * Optional because not every protocol backend exposes a keysend primitive.
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

  /**
   * Get node info (pubkey, channels, local_balance_sat, etc.).
   * Each protocol returns its own SDK's node info format.
   */
  getNodeInfo(): Promise<NodeInfo>
  getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }>
  /** Returns empty array for protocols without channels (e.g. Spark). */
  listChannels(): Promise<unknown[]>
  listPayments(): Promise<unknown>
  listTransfers(options?: { asset_id?: string }): Promise<unknown>

  // ========================================================================
  // Protocol-Specific Send/Receive (Optional)
  // ========================================================================

  /** Create an RGB on-chain invoice (only supported by RGB protocol) */
  createRgbInvoice?(params: Record<string, unknown>): Promise<unknown>
  /** Decode an RGB invoice (only supported by RGB protocol) */
  decodeRgbInvoice?(params: Record<string, unknown>): Promise<unknown>
  /**
   * Create colorable (uncolored) UTXOs for receiving RGB assets.
   * Only supported by RGB protocol.
   */
  createRgbUtxos?(params: {
    num?: number
    size?: number
    feeRate?: number
    upTo?: boolean
  }): Promise<{ success: boolean }>
  /**
   * List the node's unspent outputs along with their RGB allocations.
   * Only supported by RGB protocol.
   */
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
  /**
   * Estimate the on-chain fee rate for the given confirmation target.
   * Only supported by RGB protocol.
   */
  estimateRgbFee?(blocks: number): Promise<{ fee_rate: number }>
  /**
   * Detailed BTC balance with vanilla / colored split.
   * Only supported by RGB protocol.
   */
  getRgbDetailedBalance?(): Promise<{
    vanilla: { settled: number; future: number; spendable: number }
    colored: { settled: number; future: number; spendable: number }
  }>
  /** Get invoice status */
  getInvoiceStatus?(params: { invoice: string }): Promise<unknown>
  /** Send an RGB asset on-chain (only supported by RGB protocol) */
  sendAsset?(params: Record<string, unknown>): Promise<unknown>
  /** Send BTC on-chain */
  sendBtcOnchain?(params: { address: string; amount: number; feeRate?: number }): Promise<unknown>
  /**
   * Broadcast a raw, fully-signed network transaction (hex) through the
   * adapter's node. Optional — when absent, the dApp handler falls back to a
   * public Esplora broadcaster for the wallet's network.
   */
  broadcastTransaction?(txHex: string): Promise<{ txid: string }>
  /**
   * Sign a PSBT (BIP 174) using wallet-owned inputs. The implementation MUST
   * parse the PSBT before showing any confirmation UI, sign only inputs whose
   * BIP32 derivation paths match a key in this wallet, and return
   * { psbt: originalHex, unchanged: true } when no owned inputs are found
   * rather than throwing. Optional — only adapters with direct access to the
   * wallet's Bitcoin signing keys implement it.
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

  /** Create a Spark-native invoice (only supported by Spark protocol) */
  createSparkInvoice?(request: InvoiceRequest): Promise<Invoice>
  /**
   * Auto-claim a Spark L1 (single-use) deposit. Looks up confirmed unclaimed
   * UTXOs paid to the given deposit address and credits them to the wallet.
   * Returns `awaiting` while no UTXO is confirmed yet.
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
   * Requires `request.amount` to be positive.
   */
  createArkadeLightningInvoice?(request: InvoiceRequest): Promise<Invoice>
  /** List virtual transaction outputs (only supported by Arkade protocol) */
  getVtxos?(): Promise<Record<string, unknown>[]>
  /** List boarding UTXOs (only supported by Arkade protocol) */
  getBoardingUtxos?(): Promise<Record<string, unknown>[]>
  /** Onboard funds to Arkade (only supported by Arkade protocol) */
  onboard?(): Promise<{ txid: string }>
  /** Offboard funds from Arkade to on-chain (only supported by Arkade protocol) */
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
   * Generic protocol-operation escape hatch. Used by the WDK adapters
   * (e.g. RlnWdkAdapter) for operations not yet promoted to typed methods.
   * No native adapter is required to implement it.
   */
  executeProtocolOperation?(operation: string, params: any): Promise<any>
}

/**
 * Protocol adapter factory
 */
export interface IProtocolAdapterFactory {
  createAdapter(protocol: ProtocolType): IProtocolAdapter
  getSupportedProtocols(): ProtocolType[]
}

/**
 * Protocol adapter registry
 */
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
