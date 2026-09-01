/**
 * Protocol Manager — central manager for all protocol operations.
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
  asSwapRecoveryOperations,
  type ISimplicityOperations,
} from '../adapters/IProtocolAdapter'
import type { KaleidoswapSwapRecord } from '../swap/kaleidoswap-swap-store'
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
   * Fallback used by `verifyMessage` when the adapter has no native support.
   * Hosts inject a recoverable-ECDSA verifier; absent one, `verifyMessage`
   * throws NOT_SUPPORTED.
   */
  verifyMessageFallback?: (message: string, signature: string) => Promise<string>
  /**
   * Optional signing/spend policy. When set, fund-moving and signing operations
   * are gated through `evaluatePolicy` and throw `PolicyError` on denial. Omit
   * for no enforcement. The active grant is selected with `setActiveGrant()`.
   */
  policy?: SigningPolicy
  /**
   * Permit callers to obtain raw adapters while a policy is configured. Raw
   * adapters bypass every policy check, so this defaults to false whenever
   * `policy` is present.
   */
  allowUnsafeAdapterAccess?: boolean
}

export interface BalanceRefreshResult {
  protocol: ProtocolType
  ok: boolean
  error?: unknown
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
   * Set (or clear) the capability grant applied to subsequent gated operations.
   * No-op unless a policy is configured.
   */
  setActiveGrant(grantId: string | null): void {
    this.activeGrantId = grantId ?? undefined
  }

  /**
   * Gate a fund-moving/signing op through the policy; no-op without one.
   * `opts.protocol` overrides the protocol evaluated against, for ops routed to
   * a fixed adapter (Liquid PSET ops always act on LIQUID).
   */
  private enforce(
    operation: PolicyOperation,
    opts: {
      amountSat?: number
      assetId?: string
      assetAmount?: string
      destination?: string
      protocol?: ProtocolType
    } = {},
  ): void {
    enforcePolicy(
      {
        operation,
        protocol: opts.protocol ?? this.activeProtocol ?? undefined,
        grantId: this.activeGrantId,
        amountSat: opts.amountSat,
        assetId: opts.assetId,
        assetAmount: opts.assetAmount,
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
   * Static capability manifest for a registered protocol (empty if unregistered).
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
   * Raw adapter access bypasses every manager policy gate, so it is disabled by
   * default when a policy is configured.
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

      // Tear the live session down before installing a new one. Without this the
      // previous wallet's client was simply dropped undisposed — the mechanism
      // that made the A7 cross-wallet leak deterministic (audit finding F-F6).
      //
      // Bounded, and its failure is logged rather than propagated: every
      // adapter's `disconnect()` revokes local signing capability synchronously
      // before awaiting any third-party teardown, so a rejection here means only
      // that the OLD SDK's cleanup failed. Refusing the new connection over that
      // would leave the host unable to switch wallets because the wallet it is
      // leaving is wedged. Same policy as the adapter-side
      // `BaseWdkAdapter.releasePreviousConnection()` (32eea17), which this makes
      // redundant-but-harmless: that hook early-returns once the manager has run.
      if (adapter.isConnected()) {
        try {
          await this.disconnectAdapterBounded(adapter)
        } catch (error: unknown) {
          this.log.warn(
            `[ProtocolManager] Error tearing down the previous ${protocol} session:`,
            error,
          )
        }
        if (!this.isConnectionCurrent(protocol, generation)) {
          throw new ProtocolError(
            `Connection invalidated: ${protocol}`,
            protocol,
            'CONNECTION_INVALIDATED',
          )
        }
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

  /**
   * Tear down every registered adapter. This is the LOCK PATH — the CHANGELOG
   * names it as such, and a host calls it when the user locks the wallet.
   *
   * Every adapter is attempted, in parallel, under the same {@link
   * DISCONNECT_TIMEOUT_MS} bound as `disconnect(protocol)`, so one hung SDK
   * cannot stop the others being torn down. Routing is invalidated
   * synchronously, before any third-party cleanup is awaited.
   *
   * REJECTS when any adapter failed or timed out, naming them, with the
   * individual reasons on `details`. It previously resolved and only logged
   * those failures, so a host awaiting it showed a locked wallet while a
   * still-connected adapter went on signing — the exact state this method exists
   * to prevent, reported as success. Resolution now means every adapter really
   * is down; a rejection means the host must not present the wallet as locked.
   *
   * A rejection is not a reason to retry blindly: the successful adapters are
   * already torn down, and `getAllConnectionInfo()` reports which are not.
   */
  async disconnectAll(): Promise<void> {
    const adapters = this.registry.getAll()
    for (const adapter of adapters) this.bumpConnectionGeneration(adapter.protocolName)
    // Invalidate routing synchronously, before any third-party cleanup await.
    this.activeProtocol = null
    const results = await Promise.allSettled(
      adapters.map((adapter) => this.disconnectAdapterBounded(adapter)),
    )
    const failures: { protocol: ProtocolType; reason: unknown }[] = []
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.log.error(
          `[ProtocolManager] Error disconnecting ${adapters[index].protocolName}:`,
          result.reason,
        )
        failures.push({ protocol: adapters[index].protocolName, reason: result.reason })
      }
    })
    if (failures.length > 0) {
      throw new ProtocolError(
        `Failed to disconnect ${failures.map((f) => f.protocol).join(', ')} — ` +
          `the wallet is NOT fully locked`,
        failures[0].protocol,
        'DISCONNECT_INCOMPLETE',
        failures,
      )
    }
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
   * Invalidate every connected adapter's balance cache. Tolerates per-adapter
   * failures so one slow protocol can't block the others.
   */
  async refreshBalances(): Promise<void> {
    const results = await this.refreshBalancesWithResults()
    for (const result of results) {
      if (!result.ok) {
        this.log.error(`[ProtocolManager] Error refreshing balances for ${result.protocol}:`, result.error)
      }
    }
  }

  /** Refresh every connected adapter and return each outcome without rejecting the batch. */
  async refreshBalancesWithResults(): Promise<BalanceRefreshResult[]> {
    const adapters = this.registry.getAll().filter((adapter) => adapter.isConnected())
    const settled = await Promise.allSettled(adapters.map((adapter) => adapter.refreshBalances()))
    return settled.map((result, index) => result.status === 'fulfilled'
      ? { protocol: adapters[index].protocolName, ok: true }
      : { protocol: adapters[index].protocolName, ok: false, error: result.reason })
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
   * Sat amount a send will actually move, for policy evaluation (finding F-F1).
   *
   * The INVOICE wins whenever it encodes an amount. The adapters forward the
   * caller's `amount` only for amountless invoices — both send paths gate on
   * `decodeBolt11(...).amountMsat == null`, so stale UI state or WebLN args cannot
   * silently re-amount a payment. Preferring `request.amount` here evaluated a
   * number the adapters discard: a caller could pass a 1,000,000-sat invoice with
   * `amount: 500` and clear a 1,000-sat cap while the wallet paid the full
   * 1,000,000.
   *
   * Undefined only for a truly amountless invoice with no explicit amount — which
   * the policy engine treats as unknown and denies whenever a cap is set.
   */
  private resolveSendAmountSat(request: PaymentRequest): number | undefined {
    const invoiceAmountSat = decodeBolt11(request.invoice).amountSat
    if (invoiceAmountSat != null) return invoiceAmountSat
    return request.amount ?? undefined
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
   * Sign a message with the active adapter's identity key (LND-style zbase32).
   * Throws if unimplemented — callers fall back to their own signer.
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
   * Verify an LND-style zbase32 signature. Active adapter, else the injected
   * fallback, else NOT_SUPPORTED.
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

  /**
   * Resolve the Liquid PSET group from the *registered LIQUID adapter*, never
   * from whichever protocol is merely active: a non-Liquid adapter that happens
   * to implement these must not receive a Liquid PSET. Fails closed.
   */
  private liquidSimplicityOperations(): ISimplicityOperations {
    const adapter = this.registry.get('LIQUID')
    if (!adapter) {
      throw new ProtocolError(
        'Liquid Simplicity/PSET operations require a registered LIQUID adapter',
        'LIQUID',
        'NOT_SUPPORTED',
      )
    }
    const operations = asSimplicityOperations(adapter)
    if (!operations) {
      throw new ProtocolError(
        'The registered LIQUID adapter does not implement the Simplicity/PSET operation group',
        'LIQUID',
        'NOT_SUPPORTED',
      )
    }
    return operations
  }

  /**
   * Finalize/broadcast of a Liquid PSET stays disabled until an exact-byte
   * `LiquidSpendAuthorization` exists: a PSET can carry multiple assets and
   * blinded values, so `amountSat` cannot authorize it safely. Fail closed.
   */
  private liquidSpendUnsupported(operation: string): never {
    throw new ProtocolError(
      `${operation} is disabled until an exact-byte Liquid spend authorization contract exists`,
      'LIQUID',
      'NOT_SUPPORTED',
    )
  }

  async getSimplicityCapabilities(): Promise<SimplicityCapabilities> {
    return this.liquidSimplicityOperations().getSimplicityCapabilities()
  }

  async inspectLiquidPset(psetBase64: string): Promise<LiquidPsetReview> {
    return this.liquidSimplicityOperations().inspectLiquidPset(psetBase64)
  }

  async blindLiquidPset(psetBase64: string): Promise<string> {
    this.enforce('blindLiquidPset', { protocol: 'LIQUID' })
    return this.liquidSimplicityOperations().blindLiquidPset(psetBase64)
  }

  async signLiquidPset(request: LiquidPsetSignRequest): Promise<LiquidPsetSignResult> {
    this.enforce('signLiquidPset', { protocol: 'LIQUID' })
    return this.liquidSimplicityOperations().signLiquidPset(request)
  }

  async finalizeLiquidPset(_psetBase64: string): Promise<{ pset: string; transactionHex: string; txid: string }> {
    this.liquidSpendUnsupported('finalizeLiquidPset')
  }

  async broadcastLiquidPset(_psetBase64: string): Promise<{ txid: string }> {
    this.liquidSpendUnsupported('broadcastLiquidPset')
  }

  async deriveSimplicityPublicKey(derivationPath?: string): Promise<{ publicKey: string; derivationPath: string }> {
    return this.liquidSimplicityOperations().deriveSimplicityPublicKey(derivationPath)
  }

  async compileSimplicityProgram(request: SimplicityCompileRequest): Promise<SimplicityCompileResult> {
    return this.liquidSimplicityOperations().compileSimplicityProgram(request)
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
    // `Quote.fromAmount` is in RAW BASE UNITS of `quote.fromAsset` (documented on
    // `QuoteRequest`, types/base.ts:233-238, and on the swap boundary,
    // KaleidoswapSwap.ts:11-16) — satoshis ONLY when the from-asset is BTC.
    // `PolicyRequest.amountSat` is satoshis (policy/index.ts:30). Passing one as
    // the other made a sat-denominated cap meaningless for every non-BTC
    // from-asset: `{ maxAmountSat: 100_000 }` allowed a quote of
    // `{ fromAsset: 'XAUT', fromAmount: 90_000 }` — thousands of dollars, millions
    // of sats — because 90_000 <= 100_000 numerically.
    //
    // A sat-denominated cap cannot bound an arbitrary asset without a price
    // oracle. Non-BTC swaps therefore carry their asset id and raw amount to the
    // policy, which applies an explicit `maxAmountByAsset` entry or keeps the
    // existing fail-closed AMOUNT_UNKNOWN denial when none exists.
    const fromIsSats = quote.fromAsset === 'BTC'
    this.enforce('swap', {
      amountSat: fromIsSats ? quote.fromAmount : undefined,
      assetId: fromIsSats ? undefined : quote.fromAsset,
      assetAmount: fromIsSats ? undefined : String(quote.fromAmount),
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

  /** Enumerate non-terminal swaps retained by the active adapter. */
  async listIncompleteSwaps(): Promise<KaleidoswapSwapRecord[]> {
    const adapter = this.getActiveAdapterUnchecked()
    const recovery = asSwapRecoveryOperations(adapter)
    if (!recovery) {
      throw new ProtocolError(
        'Swap recovery not supported by active protocol',
        adapter.protocolName,
        'NOT_SUPPORTED',
      )
    }
    return recovery.listIncompleteSwaps()
  }

  /** Resume maker status inspection by an RFQ id or payment hash. */
  async resumeSwap(identifier: string, accessToken?: string): Promise<SwapResult> {
    const adapter = this.getActiveAdapterUnchecked()
    const recovery = asSwapRecoveryOperations(adapter)
    if (!recovery) {
      throw new ProtocolError(
        'Swap recovery not supported by active protocol',
        adapter.protocolName,
        'NOT_SUPPORTED',
      )
    }
    return recovery.resumeSwap(identifier, accessToken)
  }

  // ========================================================================
  // Cross-Protocol Operations
  // ========================================================================

  /**
   * Assets across all connected protocols, in parallel with an 8s per-adapter
   * timeout so one degraded backend can't freeze the list.
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
   * Transactions across all connected protocols. Parallel + per-protocol timeout,
   * as `listAllAssets`.
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
   * Asset counts across all connected protocols, total and per protocol.
   *
   * Fiat/BTC value is deliberately absent: the engine carries no price oracle, so
   * a `value` field could only be a hardcoded 0 that callers would trust.
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
