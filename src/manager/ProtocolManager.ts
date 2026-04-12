/**
 * Protocol Manager
 * Central manager for all protocol operations
 * Ported from rate-extension/src/protocols/manager/ProtocolManager.ts
 */

import {
  ProtocolType,
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
  QuoteRequest,
  Quote,
  SwapResult,
  ProtocolError,
} from '../types/base'

import {
  IProtocolAdapter,
  BaseProtocolConfig,
  ProtocolAdapterRegistry,
} from '../adapters/IProtocolAdapter'

export interface ProtocolManagerConfig {
  defaultProtocol?: ProtocolType
  autoConnect?: boolean
  enabledProtocols?: ProtocolType[]
}

export class ProtocolManager {
  private registry: ProtocolAdapterRegistry
  private activeProtocol: ProtocolType | null = null

  constructor(_config: ProtocolManagerConfig = {}) {
    this.registry = new ProtocolAdapterRegistry()
    this.activeProtocol = _config.defaultProtocol || null
  }

  // ========================================================================
  // Registry Management
  // ========================================================================

  registerAdapter(adapter: IProtocolAdapter): void {
    this.registry.register(adapter)
    console.log(`[ProtocolManager] Registered ${adapter.protocolName} adapter`)
  }

  getSupportedProtocols(): ProtocolType[] {
    return this.registry.getSupportedProtocols()
  }

  isProtocolSupported(protocol: ProtocolType): boolean {
    return this.registry.has(protocol)
  }

  // ========================================================================
  // Protocol Selection
  // ========================================================================

  async setActiveProtocol(protocol: ProtocolType): Promise<void> {
    if (!this.isProtocolSupported(protocol)) {
      throw new ProtocolError(`Protocol not supported: ${protocol}`, protocol)
    }

    const adapter = this.registry.get(protocol)!
    if (!adapter.isConnected()) {
      throw new ProtocolError(`Protocol not connected: ${protocol}`, protocol, 'NOT_CONNECTED')
    }

    this.activeProtocol = protocol
    console.log(`[ProtocolManager] Active protocol set to ${protocol}`)
  }

  getActiveProtocol(): ProtocolType | null {
    return this.activeProtocol
  }

  public getActiveAdapter(): IProtocolAdapter {
    if (!this.activeProtocol) {
      throw new Error('No active protocol set')
    }

    const adapter = this.registry.get(this.activeProtocol)
    if (!adapter) {
      throw new Error(`Adapter not found for protocol: ${this.activeProtocol}`)
    }

    return adapter
  }

  getAdapter(protocol: ProtocolType): IProtocolAdapter {
    const adapter = this.registry.get(protocol)
    if (!adapter) {
      throw new Error(`Adapter not found for protocol: ${protocol}`)
    }
    return adapter
  }

  /**
   * Try to get an adapter, returning undefined if not registered.
   */
  getAdapterIfAvailable(protocol: ProtocolType): IProtocolAdapter | undefined {
    return this.registry.get(protocol)
  }

  // ========================================================================
  // Connection Management
  // ========================================================================

  async connect(protocol: ProtocolType, config: BaseProtocolConfig): Promise<void> {
    const adapter = this.registry.get(protocol)
    if (!adapter) {
      throw new ProtocolError(`Protocol not found: ${protocol}`, protocol, 'NOT_FOUND')
    }

    await adapter.connect(config)
    console.log(`[ProtocolManager] Connected to ${protocol}`)

    // Auto-set as active if no active protocol
    if (!this.activeProtocol) {
      this.activeProtocol = protocol
    }
  }

  async disconnect(protocol: ProtocolType): Promise<void> {
    const adapter = this.registry.get(protocol)
    if (adapter) {
      await adapter.disconnect()
      console.log(`[ProtocolManager] Disconnected from ${protocol}`)

      if (this.activeProtocol === protocol) {
        this.activeProtocol = null
      }
    }
  }

  async disconnectAll(): Promise<void> {
    for (const adapter of this.registry.getAll()) {
      try {
        await adapter.disconnect()
      } catch (error) {
        console.error(`[ProtocolManager] Error disconnecting ${adapter.protocolName}:`, error)
      }
    }
    this.activeProtocol = null
  }

  async getAllConnectionInfo(): Promise<Map<ProtocolType, ConnectionInfo>> {
    const info = new Map<ProtocolType, ConnectionInfo>()

    for (const adapter of this.registry.getAll()) {
      if (adapter.isConnected()) {
        const connectionInfo = await adapter.getConnectionInfo()
        info.set(adapter.protocolName, connectionInfo)
      }
    }

    return info
  }

  // ========================================================================
  // Unified Operations (Route to Active Protocol)
  // ========================================================================

  async listAssets(): Promise<UnifiedAsset[]> {
    return this.getActiveAdapter().listAssets()
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    return this.getActiveAdapter().getAsset(assetId)
  }

  async getAssetBalance(assetId: string) {
    return this.getActiveAdapter().getAssetBalance(assetId)
  }

  async refreshBalances(): Promise<void> {
    return this.getActiveAdapter().refreshBalances()
  }

  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    return this.getActiveAdapter().listTransactions(filter)
  }

  async getTransaction(txId: string, assetId?: string): Promise<UnifiedTransaction> {
    return this.getActiveAdapter().getTransaction(txId, assetId)
  }

  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    return this.getActiveAdapter().createInvoice(request)
  }

  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    return this.getActiveAdapter().decodeInvoice(invoice)
  }

  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    return this.getActiveAdapter().sendPayment(request)
  }

  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    return this.getActiveAdapter().getPaymentStatus(paymentHash)
  }

  async getReceiveAddress(assetId?: string): Promise<Address> {
    return this.getActiveAdapter().getReceiveAddress(assetId)
  }

  async getSwapQuote(request: QuoteRequest): Promise<Quote> {
    const adapter = this.getActiveAdapter()
    if (!adapter.supportsSwaps() || !adapter.getSwapQuote) {
      throw new ProtocolError(
        'Swaps not supported by active protocol',
        adapter.protocolName,
        'NOT_SUPPORTED'
      )
    }
    return adapter.getSwapQuote(request)
  }

  async executeSwap(quote: Quote): Promise<SwapResult> {
    const adapter = this.getActiveAdapter()
    if (!adapter.supportsSwaps() || !adapter.executeSwap) {
      throw new ProtocolError(
        'Swaps not supported by active protocol',
        adapter.protocolName,
        'NOT_SUPPORTED'
      )
    }
    return adapter.executeSwap(quote)
  }

  // ========================================================================
  // Cross-Protocol Operations
  // ========================================================================

  async listAllAssets(): Promise<UnifiedAsset[]> {
    const allAssets: UnifiedAsset[] = []

    for (const adapter of this.registry.getAll()) {
      if (adapter.isConnected()) {
        try {
          const assets = await adapter.listAssets()
          allAssets.push(...assets)
        } catch (error) {
          console.error(`[ProtocolManager] Error listing assets for ${adapter.protocolName}:`, error)
        }
      }
    }

    return allAssets
  }

  async listAllTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    const allTransactions: UnifiedTransaction[] = []

    for (const adapter of this.registry.getAll()) {
      if (adapter.isConnected()) {
        try {
          const transactions = await adapter.listTransactions(filter)
          allTransactions.push(...transactions)
        } catch (error) {
          console.error(`[ProtocolManager] Error listing transactions for ${adapter.protocolName}:`, error)
        }
      }
    }

    return allTransactions.sort((a, b) => b.timestamp - a.timestamp)
  }

  async findAsset(assetId: string): Promise<UnifiedAsset | null> {
    for (const adapter of this.registry.getAll()) {
      if (adapter.isConnected()) {
        try {
          const asset = await adapter.getAsset(assetId)
          if (asset) return asset
        } catch (_error) {
          // Asset not found in this protocol, continue
        }
      }
    }
    return null
  }

  async getPortfolioSummary(): Promise<{
    totalAssets: number
    totalValue: number
    protocolBreakdown: Map<ProtocolType, { assets: number; value: number }>
  }> {
    const allAssets = await this.listAllAssets()
    const breakdown = new Map<ProtocolType, { assets: number; value: number }>()

    for (const asset of allAssets) {
      if (!breakdown.has(asset.protocol)) {
        breakdown.set(asset.protocol, { assets: 0, value: 0 })
      }
      const entry = breakdown.get(asset.protocol)!
      entry.assets++
    }

    return {
      totalAssets: allAssets.length,
      totalValue: 0,
      protocolBreakdown: breakdown,
    }
  }
}
