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
import type { ProtocolCapability } from '../capabilities/operations'
import { type Logger, getLogger } from '../ports'
import { enforcePolicy, type SigningPolicy, type PolicyOperation } from '../policy'

/** Per-protocol timeout for cross-protocol fan-out reads (assets/transactions). */
const PER_PROTOCOL_TIMEOUT_MS = 8_000

export interface ProtocolManagerConfig {
  defaultProtocol?: ProtocolType
  autoConnect?: boolean
  enabledProtocols?: ProtocolType[]
  /** Logger override; defaults to the injected platform logger (or console). */
  logger?: Logger
  /**
   * Generic message-verification fallback used by `verifyMessage` when the
   * active adapter does not implement `verifyMessage` itself. Hosts inject a
   * recoverable-ECDSA verifier (returns the signer's hex pubkey). When absent,
   * `verifyMessage` throws NOT_SUPPORTED for adapters without native support.
   */
  verifyMessageFallback?: (message: string, signature: string) => Promise<string>
  /**
   * Optional signing/spend policy. When set, fund-moving + signing operations
   * (sendPayment/payKeysend/executeSwap/signMessage) are gated through
   * `evaluatePolicy` and throw `PolicyError` on denial. Omit for no enforcement
   * (default, fully backward-compatible). The active grant is selected with
   * `setActiveGrant()`.
   */
  policy?: SigningPolicy
}

export class ProtocolManager {
  private registry: ProtocolAdapterRegistry
  private activeProtocol: ProtocolType | null = null
  private log: Logger
  private verifyMessageFallback?: (message: string, signature: string) => Promise<string>
  private policy?: SigningPolicy
  private activeGrantId?: string

  constructor(_config: ProtocolManagerConfig = {}) {
    this.registry = new ProtocolAdapterRegistry()
    this.activeProtocol = _config.defaultProtocol || null
    this.log = _config.logger ?? getLogger()
    this.verifyMessageFallback = _config.verifyMessageFallback
    this.policy = _config.policy
  }

  /**
   * Set (or clear) the capability grant applied to subsequent gated operations
   * — e.g. the app/dapp/deep-link currently driving the wallet. No-op unless a
   * policy is configured.
   */
  setActiveGrant(grantId: string | null): void {
    this.activeGrantId = grantId ?? undefined
  }

  /** Gate a fund-moving/signing op through the policy. No-op when no policy is set. */
  private enforce(operation: PolicyOperation, opts: { amountSat?: number; destination?: string } = {}): void {
    enforcePolicy(
      {
        operation,
        protocol: this.activeProtocol ?? undefined,
        grantId: this.activeGrantId,
        amountSat: opts.amountSat,
        destination: opts.destination,
      },
      this.policy,
    )
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
  // Capability Manifest
  // ========================================================================

  /**
   * Static capability manifest for a registered protocol (empty if not
   * registered). Capabilities are static, so this works while unconfigured.
   */
  getCapabilities(protocol: ProtocolType): readonly ProtocolCapability[] {
    return this.registry.get(protocol)?.capabilities ?? []
  }

  /** Capability manifest for every registered protocol. */
  getAllCapabilities(): Partial<Record<ProtocolType, readonly ProtocolCapability[]>> {
    const result: Partial<Record<ProtocolType, readonly ProtocolCapability[]>> = {}
    for (const adapter of this.registry.getAll()) {
      result[adapter.protocolName] = adapter.capabilities
    }
    return result
  }

  /** Whether a protocol declares support for a given operation. */
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

    // Query connected adapters in parallel with the same per-protocol timeout as
    // the other cross-protocol reads — awaiting each serially let one degraded
    // backend hang the whole connection-info panel indefinitely.
    const adapters = this.registry.getAll().filter((a) => a.isConnected())
    const results = await Promise.allSettled(
      adapters.map((a) => this.withTimeout(a.getConnectionInfo(), a.protocolName, 'getConnectionInfo'))
    )
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') info.set(adapters[index].protocolName, result.value)
      else this.log.error(`[ProtocolManager] Error getting connection info for ${adapters[index].protocolName}:`, result.reason)
    })

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
   * Invalidate every connected adapter's balance cache so the next read is
   * fresh. Tolerates per-adapter failures — one slow protocol can't block the
   * others.
   */
  async refreshBalances(): Promise<void> {
    const adapters = this.registry.getAll().filter((a) => a.isConnected())
    const results = await Promise.allSettled(adapters.map((a) => a.refreshBalances()))
    // Surface per-adapter failures (consistent with listAllAssets/listAllTransactions):
    // a silently-swallowed invalidation leaves a stale balance with no diagnostic trail.
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.log.error(`[ProtocolManager] Error refreshing balances for ${adapters[index].protocolName}:`, result.reason)
      }
    })
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
    this.enforce('send', { amountSat: request.amount, destination: request.invoice })
    return this.getActiveAdapter().sendPayment(request)
  }

  async payKeysend(request: KeysendRequest): Promise<PaymentResult> {
    // keysend amount is in msat; policy limits are in sats.
    this.enforce('keysend', { amountSat: Math.ceil(request.amount / 1000), destination: request.pubkey })
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
   * Sign a message with the active adapter's wallet identity key (LND-style
   * zbase32 recoverable ECDSA). Throws if the adapter doesn't implement it —
   * callers fall back to their own mnemonic-derived signer.
   */
  async signMessage(message: string): Promise<string> {
    this.enforce('signMessage')
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
   * Verify an LND-style zbase32 signature, returning the signer's hex pubkey.
   * Routes to the active adapter, else the injected generic fallback, else
   * throws NOT_SUPPORTED.
   */
  async verifyMessage(message: string, signature: string): Promise<string> {
    const adapter = this.getActiveAdapter()
    if (typeof adapter.verifyMessage === 'function') {
      return adapter.verifyMessage(message, signature)
    }
    if (this.verifyMessageFallback) {
      return this.verifyMessageFallback(message, signature)
    }
    throw new ProtocolError(
      'verifyMessage not supported by active protocol',
      adapter.protocolName,
      'NOT_SUPPORTED'
    )
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
    this.enforce('swap', { amountSat: quote.fromAmount })
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
   * Assets across all connected protocols. Runs per-adapter calls in parallel
   * with an 8s timeout each — a single slow/degraded backend can't freeze the
   * whole list for every consumer of asset data.
   */
  async listAllAssets(): Promise<UnifiedAsset[]> {
    const adapters = this.registry.getAll().filter((a) => a.isConnected())
    const results = await Promise.allSettled(
      adapters.map((adapter) => this.withTimeout(adapter.listAssets(), adapter.protocolName, 'listAssets'))
    )

    const allAssets: UnifiedAsset[] = []
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') allAssets.push(...result.value)
      else this.log.error(`[ProtocolManager] Error listing assets for ${adapters[index].protocolName}:`, result.reason)
    })
    return allAssets
  }

  /**
   * Transactions across all connected protocols. Parallel + per-protocol
   * timeout, for the same reason as `listAllAssets`.
   */
  async listAllTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    const adapters = this.registry.getAll().filter((a) => a.isConnected())
    const results = await Promise.allSettled(
      adapters.map((adapter) =>
        this.withTimeout(adapter.listTransactions(filter), adapter.protocolName, 'listTransactions')
      )
    )

    const allTransactions: UnifiedTransaction[] = []
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') allTransactions.push(...result.value)
      else this.log.error(`[ProtocolManager] Error listing transactions for ${adapters[index].protocolName}:`, result.reason)
    })
    return allTransactions.sort((a, b) => b.timestamp - a.timestamp)
  }

  /** Race a per-protocol call against an 8s timeout, clearing the timer on settle. */
  private withTimeout<T>(p: Promise<T>, protocol: ProtocolType, op: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${op}(${protocol}) timed out after ${PER_PROTOCOL_TIMEOUT_MS}ms`)),
        PER_PROTOCOL_TIMEOUT_MS
      )
    })
    // Clear the timer whether p resolves or rejects, so a fast call never leaves
    // an 8s timer pinning the event loop alive.
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
  }

  async findAsset(assetId: string): Promise<UnifiedAsset | null> {
    // Query every connected protocol in parallel (with the same per-protocol
    // timeout as the other fan-out reads) rather than serially awaiting each —
    // a single slow backend must not stall the lookup.
    const adapters = this.registry.getAll().filter((a) => a.isConnected())
    const results = await Promise.allSettled(
      adapters.map((a) => this.withTimeout(a.getAsset(assetId), a.protocolName, 'getAsset'))
    )
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) return result.value
    }
    return null
  }

  /**
   * Asset counts across all connected protocols, in total and per protocol.
   *
   * Fiat/BTC-denominated VALUE is intentionally NOT reported here: the engine is
   * dependency-free and carries no price oracle, so a `value` field could only
   * ever be a hardcoded 0 — worse than absent, because callers would trust it.
   * The host computes value from its own rate source over these counts/assets.
   */
  async getPortfolioSummary(): Promise<{
    totalAssets: number
    protocolBreakdown: Map<ProtocolType, { assets: number }>
  }> {
    const allAssets = await this.listAllAssets()
    const breakdown = new Map<ProtocolType, { assets: number }>()

    for (const asset of allAssets) {
      const entry = breakdown.get(asset.protocol) ?? { assets: 0 }
      entry.assets++
      breakdown.set(asset.protocol, entry)
    }

    return {
      totalAssets: allAssets.length,
      protocolBreakdown: breakdown,
    }
  }
}
