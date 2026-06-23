/**
 * MemoAdapter — a minimal, dependency-free reference adapter.
 * ----------------------------------------------------------
 * Implements the full `IProtocolAdapter` contract against an in-memory BTC-only
 * "wallet". It is NOT a real protocol — it exists to show the shape every adapter
 * must satisfy and to serve as a copy-paste starting point for a new protocol.
 *
 * To add a REAL protocol you would, in addition:
 *   1. Translate your SDK's responses into the domain types in `src/types`.
 *   2. Add one entry to the capability manifest (`src/capabilities`) describing
 *      your protocol's layers + quirks — never add a method to the contract for
 *      a single protocol.
 *   3. Register your adapter with a `ProtocolManager`.
 *
 * The router, unified receive, lite aggregation, and every screen then pick it
 * up with no further changes.
 */

import type {
  IProtocolAdapter,
  ProtocolConfig,
} from '../../src/adapters/IProtocolAdapter'
import type {
  ProtocolType,
  Layer,
  UnifiedAsset,
  UnifiedTransaction,
  InvoiceRequest,
  Invoice,
  DecodedInvoice,
  PaymentRequest,
  PaymentResult,
  PaymentStatus,
  Address,
  ConnectionInfo,
  TransactionFilter,
} from '../../src/types/base'
import { PROTOCOL_OPERATIONS } from '../../src/capabilities/operations'

export class MemoAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'BTC'
  readonly supportedLayers: Layer[] = ['BTC_L1']
  readonly version = '0.0.0-example'
  readonly capabilities = PROTOCOL_OPERATIONS.BTC

  private connected = false
  private balanceSat = 0

  // --- Connection ---------------------------------------------------------
  async connect(_config: ProtocolConfig): Promise<void> {
    this.connected = true
  }
  async disconnect(): Promise<void> {
    this.connected = false
  }
  isConnected(): boolean {
    return this.connected
  }
  async getConnectionInfo(): Promise<ConnectionInfo> {
    return { protocol: this.protocolName, connected: this.connected, network: 'regtest' }
  }

  // --- Assets -------------------------------------------------------------
  async listAssets(): Promise<UnifiedAsset[]> {
    return [this.btcAsset()]
  }
  async getAsset(assetId: string): Promise<UnifiedAsset> {
    if (assetId !== 'BTC') throw new Error(`Unknown asset ${assetId}`)
    return this.btcAsset()
  }
  async getAssetBalance(): Promise<UnifiedAsset['balance']> {
    return this.btcAsset().balance
  }
  async refreshBalances(): Promise<void> {
    /* no-op: balances are already in memory */
  }

  // --- Transactions -------------------------------------------------------
  async listTransactions(_filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    return []
  }
  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    throw new Error(`No transaction ${txId}`)
  }

  // --- Payments -----------------------------------------------------------
  async createInvoice(_request: InvoiceRequest): Promise<Invoice> {
    return { invoice: 'memo:invoice', paymentHash: 'memo', expiresAt: 0 }
  }
  async decodeInvoice(_invoice: string): Promise<DecodedInvoice> {
    return { paymentHash: 'memo', destination: 'memo' }
  }
  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    const amount = Number(request.amount ?? 0)
    this.balanceSat = Math.max(0, this.balanceSat - amount)
    return { paymentHash: 'memo', amount, fee: 0, status: 'confirmed', timestamp: 0 }
  }
  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    return { paymentHash, status: 'confirmed' }
  }

  // --- Address ------------------------------------------------------------
  async getReceiveAddress(): Promise<Address> {
    return { address: 'bcrt1qexampleaddress', format: 'BTC_ADDRESS' }
  }

  // --- Node / balances ----------------------------------------------------
  async getNodeInfo() {
    return { pubkey: 'memo-node' }
  }
  async getBtcBalance() {
    return { confirmed: this.balanceSat, unconfirmed: 0, total: this.balanceSat }
  }
  async listChannels(): Promise<unknown[]> {
    return []
  }
  async listPayments(): Promise<unknown> {
    return []
  }
  async listTransfers(): Promise<unknown> {
    return []
  }

  // --- Swaps --------------------------------------------------------------
  supportsSwaps(): boolean {
    return false
  }

  // --- helpers ------------------------------------------------------------
  private btcAsset(): UnifiedAsset {
    return {
      id: 'BTC',
      name: 'Bitcoin',
      ticker: 'BTC',
      precision: 8,
      protocol: 'BTC',
      layer: 'BTC_L1',
      balance: {
        total: this.balanceSat,
        available: this.balanceSat,
        pending: 0,
        totalDisplay: String(this.balanceSat),
        availableDisplay: String(this.balanceSat),
      },
      capabilities: {
        canSend: true,
        canReceive: true,
        canSwap: false,
        supportsLightning: false,
        supportsOnchain: true,
      },
    }
  }
}
