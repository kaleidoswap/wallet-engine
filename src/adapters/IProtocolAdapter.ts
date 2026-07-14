/**
 * Protocol Adapter Interface
 * All protocol implementations must implement this contract.
 *
 * Canonical contract: this is the single source of truth shared by every host
 * (rate-extension, rate mobile, desktop). Hosts that ship their own adapters
 * implement this contract; they must NOT redeclare it. See the wallet-engine
 * integration spec (A1/A2).
 *
 * Structure: `ICoreProtocolAdapter` is the small, universal surface EVERY
 * adapter must implement. Protocol-specific method groups live in their own
 * capability interfaces (`IRgbOperations`, `ISparkOperations`, …). The public
 * `IProtocolAdapter` recomposes them as `Core & Partial<each group>`, so it is
 * structurally identical to the historical flat interface (every group method
 * is still optional on it) — existing `implements`/call sites are unaffected.
 *
 * Two ways to consume the groups:
 *   - a new adapter can `implements ICoreProtocolAdapter & IRgbOperations` to
 *     declare full RGB support (methods become REQUIRED — stronger typing than
 *     the all-optional god-interface);
 *   - a caller can narrow with `asRgbOperations(adapter)` etc. below.
 *
 * Third-party protocols implement `ICoreProtocolAdapter` (+ any groups they
 * support) and connect with any `BaseProtocolConfig`-shaped config — no edit to
 * this file required (see `ProtocolConfig`).
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
 * Base configuration common to all protocols.
 */
export interface BaseProtocolConfig {
  protocol: ProtocolType
  network?: 'mainnet' | 'testnet' | 'regtest' | 'signet'
}

/**
 * Configuration accepted by `connect()`. The known first-party configs are
 * kept as named members (autocomplete + narrowing), and any other
 * `BaseProtocolConfig`-shaped object is accepted too — so a third-party
 * protocol can define and pass its own config without editing this union.
 */
export type ProtocolConfig =
  | RgbConfig
  | SparkConfig
  | ArkadeConfig
  | (BaseProtocolConfig & Record<string, unknown>)

// ===========================================================================
// Core — the universal surface every adapter MUST implement.
// ===========================================================================

export interface ICoreProtocolAdapter {
  // --- Metadata ---
  readonly protocolName: ProtocolType
  readonly supportedLayers: Layer[]
  readonly version: string
  /**
   * Native operations this adapter supports. Static — available before the
   * adapter connects — so the UI can gate actions without per-call-site
   * network checks.
   */
  readonly capabilities: readonly ProtocolCapability[]

  // --- Connection ---
  connect(config: ProtocolConfig): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  getConnectionInfo(): Promise<ConnectionInfo>

  // --- Assets ---
  listAssets(): Promise<UnifiedAsset[]>
  getAsset(assetId: string): Promise<UnifiedAsset>
  getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']>
  refreshBalances(): Promise<void>

  // --- Transactions ---
  listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]>
  /** @param assetId - Required for RGB protocol (transfers are per-asset) */
  getTransaction(txId: string, assetId?: string): Promise<UnifiedTransaction>

  // --- Payments ---
  createInvoice(request: InvoiceRequest): Promise<Invoice>
  decodeInvoice(invoice: string): Promise<DecodedInvoice>
  sendPayment(request: PaymentRequest): Promise<PaymentResult>
  getPaymentStatus(paymentHash: string): Promise<PaymentStatus>

  // --- Address ---
  /** @param assetId - Optional asset ID (for multi-asset protocols) */
  getReceiveAddress(assetId?: string): Promise<Address>

  // --- Node & balance ---
  /** Get node info (pubkey, channels, local_balance_sat, etc.). */
  getNodeInfo(): Promise<NodeInfo>
  getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }>
  /** Returns empty array for protocols without channels (e.g. Spark). */
  listChannels(): Promise<unknown[]>
  listPayments(): Promise<unknown>
  listTransfers(options?: { asset_id?: string }): Promise<unknown>

  /** Whether this protocol offers native cross-asset swaps (see `ISwapOperations`). */
  supportsSwaps(): boolean
}

// ===========================================================================
// Capability groups — optional on the composed IProtocolAdapter, REQUIRED when
// an adapter opts into a group explicitly (`implements Core & IRgbOperations`).
// ===========================================================================

/** Spontaneous Lightning keysend. Not every backend exposes a keysend primitive. */
export interface IKeysendOperations {
  payKeysend(request: KeysendRequest): Promise<PaymentResult>
}

/** Message + PSBT signing with the wallet's keys. */
export interface ISigningOperations {
  /**
   * Sign a PSBT (BIP 174) using wallet-owned inputs. Implementations MUST parse
   * before any confirmation UI, sign only inputs matching a wallet key, and
   * return { psbt: originalHex, unchanged: true } when no owned inputs exist.
   */
  signPsbt(psbtHex: string): Promise<{ psbt: string; unchanged: boolean }>
  /**
   * Sign an arbitrary message using the wallet's Lightning identity key.
   * Returns an LND-style zbase32-encoded recoverable ECDSA signature.
   */
  signMessage(message: string): Promise<string>
  /**
   * Verify an LND-style zbase32 signature and recover the signing pubkey.
   * Returns the hex-encoded compressed public key of the signer.
   */
  verifyMessage(message: string, signature: string): Promise<string>
}

/** Raw on-chain BTC operations. */
export interface IOnchainOperations {
  sendBtcOnchain(params: { address: string; amount: number; feeRate?: number }): Promise<unknown>
  /**
   * Broadcast a raw, fully-signed network transaction (hex) through the
   * adapter's node. Callers fall back to a public broadcaster when absent.
   */
  broadcastTransaction(txHex: string): Promise<{ txid: string }>
}

/** RGB asset operations (RGB-LN / RGB-L1). */
export interface IRgbOperations {
  /** Create an RGB on-chain invoice. */
  createRgbInvoice(params: Record<string, unknown>): Promise<unknown>
  /** Decode an RGB invoice. */
  decodeRgbInvoice(params: Record<string, unknown>): Promise<unknown>
  /** Create colorable (uncolored) UTXOs for receiving RGB assets. */
  createRgbUtxos(params: { num?: number; size?: number; feeRate?: number; upTo?: boolean }): Promise<{
    success: boolean
  }>
  /** List the node's unspent outputs with their RGB allocations. */
  listRgbUnspents(): Promise<{
    unspents: Array<{
      utxo: { outpoint: string; btc_amount: number; colorable: boolean }
      rgb_allocations: Array<{ asset_id?: string | null; assignment: unknown; settled: boolean }>
    }>
  }>
  /** Estimate the on-chain fee rate for a confirmation target. */
  estimateRgbFee(blocks: number): Promise<{ fee_rate: number }>
  /** Detailed BTC balance with vanilla / colored split. */
  getRgbDetailedBalance(): Promise<{
    vanilla: { settled: number; future: number; spendable: number }
    colored: { settled: number; future: number; spendable: number }
  }>
  getInvoiceStatus(params: { invoice: string }): Promise<unknown>
  /** Send an RGB asset on-chain. */
  sendAsset(params: Record<string, unknown>): Promise<unknown>
}

/**
 * Wallet-state backup (RGB-L1 wasm). RGB is stateful: allocations/consignments
 * cannot be reconstructed from the seed alone, so state must be durably backed
 * up after every settled transfer. `backup`/`restoreBackup` produce a local
 * encrypted artifact; the `vss*` methods push/pull the same state to a versioned
 * cloud store (rgb-lib encrypts client-side — the server only sees ciphertext).
 */
export interface IBackupOperations {
  /** Encrypted wallet backup bytes (rgb-lib's own format). */
  backup(password: string): Promise<Uint8Array>
  /** Restore wallet state from encrypted backup bytes produced by `backup`. */
  restoreBackup(params: { backupBytes: Uint8Array; password: string }): Promise<void>
  /** Whether local wallet state has changed since the last backup. */
  backupInfo(): Promise<{ required: boolean }>
  /**
   * Configure VSS (cloud) backup: server URL, a stable per-wallet store id, and
   * the 32-byte signing key (hex, on a dedicated path — never a spend key).
   */
  configureVssBackup(params: { serverUrl: string; storeId: string; signingKeyHex: string }): Promise<void>
  /** Disable VSS (cloud) backup for this wallet. */
  disableVssBackup(): Promise<void>
  /** Upload an encrypted backup to the configured VSS server. Returns the new server version. */
  vssBackup(): Promise<{ serverVersion: number | null }>
  /** VSS backup status: whether a backup exists, the server version, and if a fresh backup is due. */
  vssBackupInfo(): Promise<{ backupExists: boolean; serverVersion: number | null; backupRequired: boolean }>
  /** Download and restore wallet state from the configured VSS server. */
  vssRestoreBackup(): Promise<void>
}

/** Spark-specific operations. */
export interface ISparkOperations {
  /** Create a Spark-native invoice. */
  createSparkInvoice(request: InvoiceRequest): Promise<Invoice>
  /** Auto-claim a Spark L1 (single-use) deposit. `awaiting` while no UTXO is confirmed yet. */
  claimSparkL1Deposit(params: { address: string }): Promise<{
    status: 'awaiting' | 'claimed' | 'error'
    txids?: string[]
    error?: string
  }>
  /** Sweep every previously-generated single-use Spark deposit address with unclaimed UTXOs. */
  sweepSparkL1Deposits(): Promise<{ addressesChecked: number; claimedTxids: string[]; errors: string[] }>
}

/** Arkade-specific operations. */
export interface IArkadeOperations {
  /**
   * Create a Lightning invoice that pays into Arkade via a Boltz reverse swap.
   * Requires a positive `request.amount`.
   */
  createArkadeLightningInvoice(request: InvoiceRequest): Promise<Invoice>
  /** List virtual transaction outputs. */
  getVtxos(): Promise<Record<string, unknown>[]>
  /** List boarding UTXOs. */
  getBoardingUtxos(): Promise<Record<string, unknown>[]>
  /** Onboard funds to Arkade. */
  onboard(): Promise<{ txid: string }>
  /** Offboard funds from Arkade to on-chain. */
  offboard(address: string, amount?: number): Promise<{ txid: string }>
}

/** Native cross-asset swaps. Gated by `supportsSwaps()` on the core surface. */
export interface ISwapOperations {
  getSwapQuote(request: QuoteRequest): Promise<Quote>
  executeSwap(quote: Quote): Promise<SwapResult>
  getSwapStatus(swapId: string): Promise<SwapResult>
}

/** Generic escape hatch used by some WDK adapters (allowlisted internally). */
export interface IExtensibleAdapter {
  executeProtocolOperation(operation: string, params: unknown): Promise<unknown>
}

/**
 * The canonical adapter contract: the universal core plus every capability
 * group as OPTIONAL. Structurally identical to the historical flat interface,
 * so `class X implements IProtocolAdapter` and `adapter.createRgbInvoice?.(…)`
 * are unchanged.
 */
export type IProtocolAdapter = ICoreProtocolAdapter &
  Partial<IKeysendOperations> &
  Partial<ISigningOperations> &
  Partial<IOnchainOperations> &
  Partial<IRgbOperations> &
  Partial<IBackupOperations> &
  Partial<ISparkOperations> &
  Partial<IArkadeOperations> &
  Partial<ISwapOperations> &
  Partial<IExtensibleAdapter>

// ===========================================================================
// Capability narrowing helpers — a clean, checked way to reach a group's
// methods without optional-chaining across the whole surface. Each returns the
// group interface when the adapter implements it, else null.
// ===========================================================================

const isFn = (v: unknown): v is (...args: never[]) => unknown => typeof v === 'function'

export function asSwapOperations(a: IProtocolAdapter): ISwapOperations | null {
  return a.supportsSwaps() && isFn(a.executeSwap) && isFn(a.getSwapQuote) ? (a as ISwapOperations) : null
}
export function asRgbOperations(a: IProtocolAdapter): IRgbOperations | null {
  return isFn(a.createRgbInvoice) && isFn(a.sendAsset) ? (a as IRgbOperations) : null
}
export function asSigningOperations(a: IProtocolAdapter): ISigningOperations | null {
  return isFn(a.signPsbt) && isFn(a.signMessage) ? (a as ISigningOperations) : null
}
export function asBackupOperations(a: IProtocolAdapter): IBackupOperations | null {
  return isFn(a.backup) && isFn(a.restoreBackup) ? (a as IBackupOperations) : null
}
export function asSparkOperations(a: IProtocolAdapter): ISparkOperations | null {
  return isFn(a.claimSparkL1Deposit) ? (a as ISparkOperations) : null
}
export function asArkadeOperations(a: IProtocolAdapter): IArkadeOperations | null {
  return isFn(a.onboard) && isFn(a.getVtxos) ? (a as IArkadeOperations) : null
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
