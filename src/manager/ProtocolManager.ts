/**
 * Protocol Manager
 * Central manager for all protocol operations.
 * Mirrors rate-extension/src/protocols/manager/ProtocolManager.ts, with an
 * injectable logger (no `@/lib/log` host dependency) and an engine-pure
 * verifyMessage (no mnemonic-derived fallback — that is a host concern).
 */

import {
  ProtocolType,
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
  ProtocolError,
} from '../types/base'

import {
  IProtocolAdapter,
  ProtocolConfig,
  ProtocolAdapterRegistry,
} from '../adapters/IProtocolAdapter'
import type { ProtocolCapability } from '../protocol-capabilities'

/**
 * Minimal logger the manager routes its diagnostics through. Hosts inject
 * their own (the extension passes its level-gated `log`); defaults to console.
 */
export interface ProtocolManagerLogger {
  info(...args: unknown[]): void
  error(...args: unknown[]): void
}

const defaultLogger: ProtocolManagerLogger = {
  info: (...args: unknown[]) => console.log(...args),
  error: (...args: unknown[]) => console.error(...args),
}

export interface ProtocolManagerConfig {
  defaultProtocol?: ProtocolType
  autoConnect?: boolean
  enabledProtocols?: ProtocolType[]
  /** Inject a host logger; defaults to console. */
  logger?: ProtocolManagerLogger
}

/** Per-protocol timeout for cross-protocol fan-out reads. */
const PER_PROTOCOL_TIMEOUT_MS = 8_000

export class ProtocolManager {
  private registry: ProtocolAdapterRegistry
  private activeProtocol: ProtocolType | null = null
  private log: ProtocolManagerLogger

  constructor(_config: ProtocolManagerConfig = {}) {
    this.registry = new ProtocolAdapterRegistry()
    this.activeProtocol = _config.defaultProtocol || null
    this.log = _config.logger ?? defaultLogger
  }

  // ========================================================================
  // Registry Management
  // ========================================================================

  registerAdapter(adapter: IProtocolAdapter): void {
    this.registry.register(adapter)
    this.log.info(`[ProtocolManager] Registered ${adapter.protocolName} adapter`)
  }

  getSupportedProtocols(): ProtocolType[] {
    return this.registry.getSupportedProtocols()
  }

  isProtocolSupported(protocol: ProtocolType): boolean {
    return this.registry.has(protocol)
  }

  // ========================================================================
  // Capability Manifest (GL #68)
  // ========================================================================

  /**
   * Get the static capability manifest for a registered protocol. Returns an
   * empty list if the protocol is not registered. Capabilities are static, so
   * this works even while the protocol is unconfigured/disconnected.
   */
  getCapabilities(protocol: ProtocolType): readonly ProtocolCapability[] {
    return this.registry.get(protocol)?.capabilities ?? []
  }

  /**
   * Get the capability manifest for every registered protocol.
   */
  getAllCapabilities(): Partial<Record<ProtocolType, readonly ProtocolCapability[]>> {
    const result: Partial<Record<ProtocolType, readonly ProtocolCapability[]>> = {}
    for (const adapter of this.registry.getAll()) {
      result[adapter.protocolName] = adapter.capabilities
    }
    return result
  }

  /**
   * Check whether a protocol declares support for a given operation.
   */
  protocolSupports(protocol: ProtocolType, capability: ProtocolCapability): boolean {
    return this.getCapabilities(protocol).includes(capability)
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
    this.log.info(`[ProtocolManager] Active protocol set to ${protocol}`)
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

  async connect(protocol: ProtocolType, config: ProtocolConfig): Promise<void> {
    const adapter = this.registry.get(protocol)
    if (!adapter) {
      throw new ProtocolError(`Protocol not found: ${protocol}`, protocol, 'NOT_FOUND')
    }

    await adapter.connect(config)
    this.log.info(`[ProtocolManager] Connected to ${protocol}`)

    // Auto-set as active if no active protocol
    if (!this.activeProtocol) {
      this.activeProtocol = protocol
    }
  }

  async disconnect(protocol: ProtocolType): Promise<void> {
    const adapter = this.registry.get(protocol)
    if (adapter) {
      await adapter.disconnect()
      this.log.info(`[ProtocolManager] Disconnected from ${protocol}`)

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
        this.log.error(`[ProtocolManager] Error disconnecting ${adapter.protocolName}:`, error)
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

  /**
   * Invalidate every connected adapter's in-process balance cache so the next
   * read fetches fresh values. Tolerates per-adapter failures — one slow
   * protocol can't block the others.
   */
  async refreshBalances(): Promise<void> {
    const adapters = this.registry.getAll().filter((a) => a.isConnected())
    await Promise.allSettled(adapters.map((a) => a.refreshBalances()))
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

  async payKeysend(request: KeysendRequest): Promise<PaymentResult> {
    const adapter = this.getActiveAdapter()
    if (!adapter.payKeysend) {
      throw new ProtocolError(
        'Keysend not supported by active protocol',
        adapter.protocolName,
        'NOT_SUPPORTED'
      )
    }
    return adapter.payKeysend(request)
  }

  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    return this.getActiveAdapter().getPaymentStatus(paymentHash)
  }

  /**
   * Sign a message using the active adapter's wallet identity key, producing an
   * LND-style zbase32 recoverable ECDSA signature. Throws NOT_SUPPORTED when the
   * active adapter does not implement it (the host may then fall back to its own
   * mnemonic-derived signing path).
   */
  async signMessage(message: string): Promise<string> {
    const adapter = this.getActiveAdapter()
    if (typeof adapter.signMessage !== 'function') {
      throw new ProtocolError(
        'signMessage not supported by active protocol',
        adapter.protocolName,
        'NOT_SUPPORTED'
      )
    }
    return adapter.signMessage(message)
  }

  /**
   * Verify an LND-style zbase32 signature and return the recovered signer pubkey
   * as a hex string. Throws NOT_SUPPORTED when the active adapter does not
   * implement it — the engine carries no protocol-agnostic recovery fallback
   * (that is a host concern, e.g. rate-extension's `ln-message-sign`).
   */
  async verifyMessage(message: string, signature: string): Promise<string> {
    const adapter = this.getActiveAdapter()
    if (typeof adapter.verifyMessage !== 'function') {
      throw new ProtocolError(
        'verifyMessage not supported by active protocol',
        adapter.protocolName,
        'NOT_SUPPORTED'
      )
    }
    return adapter.verifyMessage(message, signature)
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

  /**
   * Get all assets across all connected protocols.
   *
   * Runs the per-adapter calls in parallel (via Promise.allSettled) and wraps
   * each one with a per-protocol timeout. Previously a sequential `await` loop,
   * which meant a single slow / degraded backend (e.g. a 30s Spark / Flashnet
   * timeout when their gateway returns HTTP 520) would freeze the whole list
   * for every consumer of asset data.
   */
  async listAllAssets(): Promise<UnifiedAsset[]> {
    const adapters = this.registry.getAll().filter((adapter) => adapter.isConnected())

    const results = await Promise.allSettled(
      adapters.map((adapter) =>
        Promise.race([
          adapter.listAssets(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `listAssets(${adapter.protocolName}) timed out after ${PER_PROTOCOL_TIMEOUT_MS}ms`
                  )
                ),
              PER_PROTOCOL_TIMEOUT_MS
            )
          ),
        ])
      )
    )

    const allAssets: UnifiedAsset[] = []
    results.forEach((result, index) => {
      const adapter = adapters[index]
      if (result.status === 'fulfilled') {
        allAssets.push(...result.value)
      } else {
        this.log.error(
          `[ProtocolManager] Error listing assets for ${adapter.protocolName}:`,
          result.reason
        )
      }
    })

    return allAssets
  }

  /**
   * Get all transactions across all connected protocols.
   *
   * Parallel + per-protocol timeout for the same reason as `listAllAssets`:
   * a degraded backend should not freeze the activity view for every protocol.
   */
  async listAllTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    const adapters = this.registry.getAll().filter((adapter) => adapter.isConnected())

    const results = await Promise.allSettled(
      adapters.map((adapter) =>
        Promise.race([
          adapter.listTransactions(filter),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `listTransactions(${adapter.protocolName}) timed out after ${PER_PROTOCOL_TIMEOUT_MS}ms`
                  )
                ),
              PER_PROTOCOL_TIMEOUT_MS
            )
          ),
        ])
      )
    )

    const allTransactions: UnifiedTransaction[] = []
    results.forEach((result, index) => {
      const adapter = adapters[index]
      if (result.status === 'fulfilled') {
        allTransactions.push(...result.value)
      } else {
        this.log.error(
          `[ProtocolManager] Error listing transactions for ${adapter.protocolName}:`,
          result.reason
        )
      }
    })

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
