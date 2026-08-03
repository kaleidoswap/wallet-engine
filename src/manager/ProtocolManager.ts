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
  asSimplicityOperations,
} from '../adapters/IProtocolAdapter'
import type { ProtocolCapability } from '../capabilities/operations'
import { type Logger, getLogger } from '../ports'
import { enforcePolicy, type SigningPolicy, type PolicyOperation } from '../policy'
import { decodeBolt11 } from '../lib/bolt11'
import type {
  LiquidPsetReview,
  LiquidPsetSignRequest,
  LiquidPsetSignResult,
  SimplicityCapabilities,
  SimplicityCompileRequest,
  SimplicityCompileResult,
} from '../types/simplicity'

/** Per-protocol timeout for cross-protocol fan-out reads (assets/transactions). */
const PER_PROTOCOL_TIMEOUT_MS = 8_000
const DISCONNECT_TIMEOUT_MS = 2_000

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
   * (sendPayment/payKeysend/executeSwap/signMessage/signPsbt/signLiquidPset) are gated through
   * `evaluatePolicy` and throw `PolicyError` on denial. Omit for no enforcement
   * (default, fully backward-compatible). The active grant is selected with
   * `setActiveGrant()`.
   */
  policy?: SigningPolicy
  /**
   * Permit callers to obtain raw adapters while a policy is configured.
   * Raw adapters bypass ProtocolManager policy checks, so this defaults to
   * false whenever `policy` is present. Trusted hosts may opt in explicitly.
   */
  allowUnsafeAdapterAccess?: boolean
}

export class ProtocolManager {
  private registry: ProtocolAdapterRegistry
  private activeProtocol: ProtocolType | null = null
  private log: Logger
  private verifyMessageFallback?: (message: string, signature: string) => Promise<string>
  private policy?: SigningPolicy
  private activeGrantId?: string
  private allowUnsafeAdapterAccess: boolean
  private connectionGeneration = new Map<ProtocolType, number>()
  private connectionJobs = new Map<ProtocolType, Promise<void>>()

  constructor(_config: ProtocolManagerConfig = {}) {
    this.registry = new ProtocolAdapterRegistry()
    this.activeProtocol = _config.defaultProtocol || null
    this.log = _config.logger ?? getLogger()
    this.verifyMessageFallback = _config.verifyMessageFallback
    this.policy = _config.policy
    this.allowUnsafeAdapterAccess =
      _config.allowUnsafeAdapterAccess ?? _config.policy === undefined
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

  private getActiveAdapterUnchecked(): IProtocolAdapter {
    if (!this.activeProtocol) {
      throw new Error('No active protocol set')
    }

    const adapter = this.registry.get(this.activeProtocol)
    if (!adapter) {
      throw new Error(`Adapter not found for protocol: ${this.activeProtocol}`)
    }

    return adapter
  }

  /**
   * Raw adapter access bypasses every manager policy gate. It is disabled by
   * default when a policy is configured; trusted hosts must opt in explicitly.
   */
  public getActiveAdapter(): IProtocolAdapter {
    this.assertUnsafeAdapterAccessAllowed()
    return this.getActiveAdapterUnchecked()
  }

  getAdapter(protocol: ProtocolType): IProtocolAdapter {
    this.assertUnsafeAdapterAccessAllowed()
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
    this.assertUnsafeAdapterAccessAllowed()
    return this.registry.get(protocol)
  }

  private assertUnsafeAdapterAccessAllowed(): void {
    if (this.policy && !this.allowUnsafeAdapterAccess) {
      throw new ProtocolError(
        'Raw adapter access is disabled while a signing/spend policy is active',
        this.activeProtocol ?? 'BTC',
        'UNSAFE_ADAPTER_ACCESS',
      )
    }
  }

  private bumpConnectionGeneration(protocol: ProtocolType): number {
    const next = (this.connectionGeneration.get(protocol) ?? 0) + 1
    this.connectionGeneration.set(protocol, next)
    return next
  }

  private isConnectionCurrent(protocol: ProtocolType, generation: number): boolean {
    return this.connectionGeneration.get(protocol) === generation
  }

  // ========================================================================
  // Connection Management
  // ========================================================================

  connect(protocol: ProtocolType, config: ProtocolConfig): Promise<void> {
    const adapter = this.registry.get(protocol)
    if (!adapter) {
      return Promise.reject(new ProtocolError(`Protocol not found: ${protocol}`, protocol, 'NOT_FOUND'))
    }

    // Serialize connects per adapter. A later connect request invalidates an
    // earlier one, waits for its cleanup, and only then starts with its config.
    const generation = this.bumpConnectionGeneration(protocol)
    const previous = this.connectionJobs.get(protocol)
    const run = (async () => {
      await previous?.catch(() => {})
      if (!this.isConnectionCurrent(protocol, generation)) {
        throw new ProtocolError(`Connection invalidated: ${protocol}`, protocol, 'CONNECTION_INVALIDATED')
      }

      await adapter.connect(config)
      if (!this.isConnectionCurrent(protocol, generation)) {
        await this.disconnectAdapterBounded(adapter)
        throw new ProtocolError(`Connection invalidated: ${protocol}`, protocol, 'CONNECTION_INVALIDATED')
      }

      this.log.info(`[ProtocolManager] Connected to ${protocol}`)
      if (!this.activeProtocol) this.activeProtocol = protocol
    })()

    this.connectionJobs.set(protocol, run)
    const clearIfCurrent = () => {
      if (this.connectionJobs.get(protocol) === run) this.connectionJobs.delete(protocol)
    }
    void run.then(clearIfCurrent, clearIfCurrent)
    return run
  }

  async disconnect(protocol: ProtocolType): Promise<void> {
    this.bumpConnectionGeneration(protocol)
    if (this.activeProtocol === protocol) this.activeProtocol = null
    const adapter = this.registry.get(protocol)
    if (adapter) {
      await this.disconnectAdapterBounded(adapter)
      this.log.info(`[ProtocolManager] Disconnected from ${protocol}`)
    }
  }

  async disconnectAll(): Promise<void> {
    const adapters = this.registry.getAll()
    for (const adapter of adapters) this.bumpConnectionGeneration(adapter.protocolName)
    // Invalidate routing synchronously, before any third-party cleanup await.
    this.activeProtocol = null
    const results = await Promise.allSettled(
      adapters.map((adapter) => this.disconnectAdapterBounded(adapter)),
    )
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.log.error(
          `[ProtocolManager] Error disconnecting ${adapters[index].protocolName}:`,
          result.reason,
        )
      }
    })
  }

  private disconnectAdapterBounded(adapter: IProtocolAdapter): Promise<void> {
    return this.withTimeoutMs(
      Promise.resolve().then(() => adapter.disconnect()),
      DISCONNECT_TIMEOUT_MS,
      `disconnect(${adapter.protocolName})`,
    )
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
    return this.getActiveAdapterUnchecked().listAssets()
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    return this.getActiveAdapterUnchecked().getAsset(assetId)
  }

  async getAssetBalance(assetId: string) {
    return this.getActiveAdapterUnchecked().getAssetBalance(assetId)
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
    return this.getActiveAdapterUnchecked().listTransactions(filter)
  }

  async getTransaction(txId: string, assetId?: string): Promise<UnifiedTransaction> {
    return this.getActiveAdapterUnchecked().getTransaction(txId, assetId)
  }

  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    return this.getActiveAdapterUnchecked().createInvoice(request)
  }

  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    return this.getActiveAdapterUnchecked().decodeInvoice(invoice)
  }

  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    this.enforce('send', { amountSat: this.resolveSendAmountSat(request), destination: request.invoice })
    return this.getActiveAdapterUnchecked().sendPayment(request)
  }

  /**
   * Sat amount a send will move, for policy evaluation: the caller's explicit
   * amount, else the value encoded in the BOLT11. Undefined only for a truly
   * amountless invoice with no explicit amount — which the policy engine treats
   * as unknown and denies whenever a spend cap is set.
   */
  private resolveSendAmountSat(request: PaymentRequest): number | undefined {
    if (request.amount != null) return request.amount
    return decodeBolt11(request.invoice).amountSat
  }

  async payKeysend(request: KeysendRequest): Promise<PaymentResult> {
    // keysend amount is in msat; policy limits are in sats.
    this.enforce('keysend', { amountSat: Math.ceil(request.amount / 1000), destination: request.pubkey })
    const adapter = this.getActiveAdapterUnchecked()
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
    return this.getActiveAdapterUnchecked().getPaymentStatus(paymentHash)
  }

  /**
   * Sign a message with the active adapter's wallet identity key (LND-style
   * zbase32 recoverable ECDSA). Throws if the adapter doesn't implement it —
   * callers fall back to their own mnemonic-derived signer.
   */
  async signMessage(message: string): Promise<string> {
    this.enforce('signMessage')
    const adapter = this.getActiveAdapterUnchecked()
    if (typeof adapter.signMessage !== 'function') {
      throw new ProtocolError(
        'signMessage not supported by active protocol',
        adapter.protocolName,
        'NOT_SUPPORTED'
      )
    }
    return adapter.signMessage(message)
  }

  /** Sign a PSBT through the same policy boundary as every other signing op. */
  async signPsbt(psbtHex: string): Promise<{ psbt: string; unchanged: boolean }> {
    this.enforce('signPsbt')
    const adapter = this.getActiveAdapterUnchecked()
    if (typeof adapter.signPsbt !== 'function') {
      throw new ProtocolError(
        'PSBT signing not supported by active protocol',
        adapter.protocolName,
        'NOT_SUPPORTED',
      )
    }
    return adapter.signPsbt(psbtHex)
  }

  /**
   * Verify an LND-style zbase32 signature, returning the signer's hex pubkey.
   * Routes to the active adapter, else the injected generic fallback, else
   * throws NOT_SUPPORTED.
   */
  async verifyMessage(message: string, signature: string): Promise<string> {
    const adapter = this.getActiveAdapterUnchecked()
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

  private simplicityOperations() {
    const adapter = this.getActiveAdapterUnchecked()
    const operations = asSimplicityOperations(adapter)
    if (!operations) {
      throw new ProtocolError(
        'Liquid Simplicity/PSET operations are not supported by the active protocol',
        adapter.protocolName,
        'NOT_SUPPORTED',
      )
    }
    return operations
  }

  async getSimplicityCapabilities(): Promise<SimplicityCapabilities> {
    return this.simplicityOperations().getSimplicityCapabilities()
  }

  async inspectLiquidPset(psetBase64: string): Promise<LiquidPsetReview> {
    return this.simplicityOperations().inspectLiquidPset(psetBase64)
  }

  async blindLiquidPset(psetBase64: string): Promise<string> {
    return this.simplicityOperations().blindLiquidPset(psetBase64)
  }

  async signLiquidPset(request: LiquidPsetSignRequest): Promise<LiquidPsetSignResult> {
    this.enforce('signLiquidPset')
    return this.simplicityOperations().signLiquidPset(request)
  }

  async finalizeLiquidPset(psetBase64: string): Promise<{ pset: string; transactionHex: string; txid: string }> {
    return this.simplicityOperations().finalizeLiquidPset(psetBase64)
  }

  async broadcastLiquidPset(psetBase64: string): Promise<{ txid: string }> {
    return this.simplicityOperations().broadcastLiquidPset(psetBase64)
  }

  async deriveSimplicityPublicKey(derivationPath?: string): Promise<{ publicKey: string; derivationPath: string }> {
    return this.simplicityOperations().deriveSimplicityPublicKey(derivationPath)
  }

  async compileSimplicityProgram(request: SimplicityCompileRequest): Promise<SimplicityCompileResult> {
    return this.simplicityOperations().compileSimplicityProgram(request)
  }

  async getReceiveAddress(assetId?: string): Promise<Address> {
    return this.getActiveAdapterUnchecked().getReceiveAddress(assetId)
  }

  async getSwapQuote(request: QuoteRequest): Promise<Quote> {
    const adapter = this.getActiveAdapterUnchecked()
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
    const receiverAddress = (quote as Quote & { receiverAddress?: unknown }).receiverAddress
    this.enforce('swap', {
      amountSat: quote.fromAmount,
      destination: typeof receiverAddress === 'string' ? receiverAddress : undefined,
    })
    const adapter = this.getActiveAdapterUnchecked()
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
    return this.withTimeoutMs(p, PER_PROTOCOL_TIMEOUT_MS, `${op}(${protocol})`)
  }

  private withTimeoutMs<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
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
