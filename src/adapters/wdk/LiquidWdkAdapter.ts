/**
 * LiquidWdkAdapter
 * ----------------
 * Wraps the WDK Liquid module (@kaleidorg/wdk-wallet-liquid, over lwk) onto the
 * `IProtocolAdapter` contract. This is the "USD" path: USDt on Liquid is the
 * lite-mode "USD" asset.
 *
 * Liquid is on-chain only — no Lightning, no invoices; receive is an address. The
 * module exposes `listAssets()` + `getTokenBalance()`, so asset enumeration works
 * natively.
 *
 * No WDK/lwk types cross the contract — everything returned is a domain type from
 * ../types/base; WDK objects are held as `any`.
 */

import { IProtocolAdapter, BaseProtocolConfig } from '../IProtocolAdapter'
import {
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
  TransactionStatus,
  ProtocolError,
} from '../../types/base'
import { getCapabilities } from '../../capabilities'
import { PROTOCOL_OPERATIONS, type ProtocolCapability } from '../../capabilities/operations'
import { loadWdkModule } from './moduleLoader'
import { BaseWdkAdapter } from './BaseWdkAdapter'

// Re-exported from the neutral constants module so core (disclosure) never has
// to import this adapter to reach the asset id.
export { LIQUID_USDT_ASSET_ID } from '../../constants'
import { LIQUID_USDT_ASSET_ID } from '../../constants'
import { formatAmount } from '../../lib/amount'
import type {
  LiquidPsetReview,
  LiquidPsetSignRequest,
  LiquidPsetSignResult,
  SimplicityCapabilities,
  SimplicityCompileRequest,
  SimplicityCompileResult,
} from '../../types/simplicity'
import { applyTransactionFilter } from '../../lib/transaction-filter'

export interface LiquidSyncWarning {
  code: 'LIQUID_WATERFALLS_FALLBACK'
  message: string
  details?: { reason?: 'waterfalls_failed' }
}

/** The unblinding data of a single confidential output, as observed. */
export interface LiquidOutputSecretsRecord {
  /** Funding transaction id, display (big-endian) order. */
  txid: string
  /** Output index within `txid`. */
  vout: number
  /** Unblinded asset id hex (64 chars). */
  assetId: string
  /** Unblinded amount in the asset's smallest unit, as a decimal string. */
  value: string
  /** Asset blinding factor hex (64 chars). */
  assetBlindingFactor: string
  /** Value blinding factor hex (64 chars). */
  valueBlindingFactor: string
}

/**
 * Host-supplied durable store for confidential outputs' unblinding data.
 *
 * A confidential output's asset, amount and blinding factors are not determined by
 * the descriptor, so restoring the mnemonic re-derives every address without
 * reconstructing those values — they are read back out of the funding transaction.
 * A wallet keeping no record has no second source if that read stops working.
 *
 * The host owns durability, per-wallet/per-network namespacing and retention; a
 * record stays relevant until its outpoint is spent. Treat the contents as key
 * material: the blinding factors are what make an output's amount and asset
 * legible.
 */
export interface LiquidSecretsStore {
  /** Persist a batch of newly observed records. Must be idempotent per outpoint. */
  put(records: LiquidOutputSecretsRecord[]): void | Promise<void>
}

export interface LiquidAdapterConfig extends BaseProtocolConfig {
  protocol: 'LIQUID'
  /** BIP-39 mnemonic for this wallet. */
  mnemonic: string
  /** BIP-44 account index (default 0). */
  accountIndex?: number
  /** Optional Esplora base URL override. */
  esploraUrl?: string
  /**
   * Use the server-side "waterfalls" scan (one request) rather than a client-side
   * gap-limit scan (~40 requests, ~10s cold). Requires `esploraUrl` to be
   * waterfalls-capable; public Blockstream Esplora is not. Default: false.
   */
  waterfalls?: boolean
  /**
   * Allow one retry through the network's standard Esplora provider if Waterfalls
   * fails. This changes providers and may disclose wallet addresses to it.
   */
  allowDefaultEsploraFallback?: boolean
  /** Optional waterfalls server recipient key; encrypts the descriptor before it is sent. */
  waterfallsRecipient?: string
  /** Receives non-fatal sync warnings, including successful Waterfalls fallback. */
  onWarning?: (warning: LiquidSyncWarning) => void | Promise<void>
  /**
   * Durable sink for the unblinding data of confidential outputs received.
   * Strongly recommended — a seed-only restore does not reconstruct it.
   * See {@link LiquidSecretsStore}.
   */
  secretsStore?: LiquidSecretsStore
}

/** Local mirror of the lwk network union (kept here so WDK/lwk types never cross the contract). */
type LiquidNetwork = 'mainnet' | 'testnet' | 'regtest'

const LIQUID_NETWORK_MAP: Record<string, LiquidNetwork> = {
  mainnet: 'mainnet',
  testnet: 'testnet',
  regtest: 'regtest',
  signet: 'testnet', // Liquid has no signet
}

/** Known asset metadata for nicer display; unknown assets fall back to their id. */
const KNOWN_ASSETS: Record<string, { ticker: string; name: string; precision: number }> = {
  [LIQUID_USDT_ASSET_ID]: { ticker: 'USDt', name: 'Tether USD', precision: 8 },
}

export class LiquidWdkAdapter extends BaseWdkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'LIQUID'
  readonly supportedLayers: Layer[] = getCapabilities('LIQUID').layers

  /**
   * Runtime-derived operation manifest. Base Liquid operations are always
   * available; experimental PSET/Simplicity ones are advertised only when the
   * account's LWK binding supports them, so the UI never offers an action the
   * binding cannot perform (fail closed).
   */
  get capabilities(): readonly ProtocolCapability[] {
    const base = PROTOCOL_OPERATIONS.LIQUID
    const caps = this.readSimplicityCapabilitiesSync()
    if (!caps) return base
    const extra: ProtocolCapability[] = []
    if (caps.pset?.inspect) extra.push('liquid-pset-inspect')
    if (caps.pset?.sign) extra.push('liquid-pset-sign')
    if (caps.simplicity?.compile) extra.push('simplicity-compile')
    return extra.length ? [...base, ...extra] : base
  }

  /**
   * Synchronous, side-effect-free read of the Simplicity capability probe.
   * `getBindingCapabilities` only inspects the binding prototype — never the
   * re-entrant Wollet or Esplora — so it is safe outside the opLock. Returns
   * undefined on failure so `capabilities` fails closed.
   */
  private readSimplicityCapabilitiesSync(): SimplicityCapabilities | undefined {
    const probe = this.account?.getSimplicityCapabilities
    if (typeof probe !== 'function') return undefined
    try {
      const caps = probe.call(this.account)
      return caps && typeof caps === 'object' ? (caps as SimplicityCapabilities) : undefined
    } catch {
      return undefined
    }
  }

  private policyAsset: string | null = null

  // lwk's Wollet is NOT re-entrant: a second call while one awaits its Esplora
  // sync panics ("recursive use of an object"). The dashboard fires balance +
  // listAssets + address concurrently, so serialize every lwk op onto one queue.
  private opLock: Promise<unknown> = Promise.resolve()
  private withLock<T>(op: () => T | Promise<T>): Promise<T> {
    // Run `op` after the previous op settles (success OR failure). Cast the
    // then() result: `this.account` is `any`, so op's inferred type would
    // otherwise collapse T to `unknown` at call sites.
    const run = this.opLock.then(op, op) as Promise<T>
    // Keep the chain alive even if an op rejects (swallow only on the chain copy).
    this.opLock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private requireExperimentalAccountMethod(name: string): (...args: any[]) => any {
    const method = this.account?.[name]
    if (typeof method !== 'function') {
      throw new ProtocolError(
        `${name} requires a Simplicity-capable @kaleidorg/wdk-wallet-liquid build`,
        'LIQUID',
        'NOT_SUPPORTED',
      )
    }
    return method.bind(this.account)
  }

  // --- Connection ---------------------------------------------------------
  async connect(config: LiquidAdapterConfig): Promise<void>
  async connect(config: BaseProtocolConfig): Promise<void>
  async connect(config: BaseProtocolConfig): Promise<void> {
    const cfg = config as LiquidAdapterConfig
    if (!cfg.mnemonic) {
      throw new ProtocolError('LiquidWdkAdapter requires a mnemonic', 'LIQUID', 'CONFIG')
    }
    await this.releasePreviousConnection()
    this.network = cfg.network ?? 'mainnet'
    // @ts-ignore — declared as a workspace/optional dep; resolved at runtime.
    const mod = await loadWdkModule('@kaleidorg/wdk-wallet-liquid', () => import('@kaleidorg/wdk-wallet-liquid'))
    const LiquidWalletManager = mod.default ?? mod
    this.manager = new LiquidWalletManager(cfg.mnemonic, {
      network: LIQUID_NETWORK_MAP[this.network] ?? 'mainnet',
      esploraUrl: cfg.esploraUrl,
      waterfalls: cfg.waterfalls,
      allowDefaultEsploraFallback: cfg.allowDefaultEsploraFallback,
      waterfallsRecipient: cfg.waterfallsRecipient,
      onWarning: cfg.onWarning,
      secretsStore: cfg.secretsStore,
    })
    this.account = await this.manager.getAccount(cfg.accountIndex ?? 0)
    this.connected = true
  }

  async disconnect(): Promise<void> {
    await super.disconnect()
    this.policyAsset = null
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    this.assertConnected()
    const info = await this.withLock(() => this.account.getNetworkInfo())
    return {
      protocol: 'LIQUID',
      connected: this.connected,
      network: info?.network ?? this.network,
      blockHeight: info?.tip_height ?? undefined,
    }
  }

  // --- Address / receive --------------------------------------------------
  async getReceiveAddress(assetId?: string): Promise<Address> {
    this.assertConnected()
    const address = await this.withLock(() => this.account.getAddress())
    return { address, format: 'LIQUID_ADDRESS', asset: assetId }
  }

  // --- Balance ------------------------------------------------------------
  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    this.assertConnected()
    const bal: bigint = await this.withLock(() => this.account.getBalance()) // L-BTC sats
    const total = Number(bal)
    return { confirmed: total, unconfirmed: 0, total }
  }

  async refreshBalances(): Promise<void> {
    // Reads coalesce scans within a freshness window (the wdk account throttles
    // `_sync`), so a manual refresh must force a fresh Esplora scan — otherwise a
    // just-arrived deposit wouldn't surface until the window lapses.
    if (this.connected && typeof this.account?.resync === 'function') {
      await this.withLock(() => this.account.resync())
    }
  }

  async listAssets(): Promise<UnifiedAsset[]> {
    this.assertConnected()
    // One lock acquisition for the whole read — the account calls inside must be
    // RAW (not the locked getBtcBalance/getPolicyAsset) to avoid self-deadlock.
    return this.withLock(async () => {
      const policy = await this.requirePolicyAsset()
      const out: UnifiedAsset[] = []

      // L-BTC (policy asset)
      const total = Number((await this.account.getBalance()) as bigint)
      out.push(
        this.toUnifiedAsset(policy, BigInt(total), {
          ticker: 'L-BTC',
          name: 'Liquid Bitcoin',
          precision: 8,
          layer: 'BTC_LIQUID',
        })
      )

      // Other Liquid assets (USDt, etc.)
      const assets: Array<{ asset_id: string; balance: string }> = await this.account.listAssets()
      for (const a of assets) {
        if (a.asset_id === policy) continue // already added as L-BTC
        const meta = KNOWN_ASSETS[a.asset_id]
        out.push(
          this.toUnifiedAsset(a.asset_id, BigInt(a.balance), {
            ticker: meta?.ticker ?? a.asset_id.slice(0, 6),
            name: meta?.name ?? 'Liquid asset',
            precision: meta?.precision ?? 8,
            layer: 'LIQUID_ASSET',
          })
        )
      }
      return out
    })
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    this.assertConnected()
    const bal: bigint = await this.withLock(() => this.account.getTokenBalance(assetId))
    const n = Number(bal)
    const precision = KNOWN_ASSETS[assetId]?.precision ?? 8
    return { total: n, available: n, pending: 0, totalDisplay: formatAmount(n, precision), availableDisplay: formatAmount(n, precision) }
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets()
    const found = assets.find((a) => a.id === assetId)
    if (!found) throw new ProtocolError(`Unknown asset ${assetId}`, 'LIQUID', 'NO_ASSET')
    return found
  }

  // --- Send ---------------------------------------------------------------
  /** L-BTC send. `invoice` carries the recipient Liquid address for on-chain protocols. */
  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    this.assertConnected()
    if (request.amount == null) {
      throw new ProtocolError('Liquid send requires an explicit amount', 'LIQUID', 'NO_AMOUNT')
    }
    const r: any = await this.withLock(() =>
      this.account.transfer({ recipient: request.invoice.trim(), amount: request.amount })
    )
    const hash: string = r?.hash ?? ''
    // A send that reports success with no transaction id can never be tracked or
    // reconciled, and a status poll on `''` returns pending forever. The in-repo
    // precedent is `ArkadeWdkAdapter.sendBtcOnchain`, which throws
    // SEND_ERROR here; docs/wdk-parity.md:68-70 calls it "never silent success".
    if (!hash) {
      throw new ProtocolError('Liquid send did not return a transaction ID', 'LIQUID', 'SEND_ERROR')
    }
    return {
      paymentHash: hash,
      amount: request.amount,
      fee: Number(r?.fee ?? 0),
      status: 'pending', // on-chain — confirms later
      timestamp: Date.now(),
    }
  }

  /** Liquid asset send (e.g. USDt). */
  async sendAsset(params: { assetId: string; address: string; amount: number; feeRate?: number }): Promise<any> {
    this.assertConnected()
    const r: any = await this.withLock(() =>
      this.account.sendAsset({
        assetId: params.assetId,
        recipient: params.address,
        amount: params.amount,
        feeRate: params.feeRate,
      })
    )
    const assetHash: string = r?.hash ?? ''
    if (!assetHash) {
      throw new ProtocolError('Liquid asset send did not return a transaction ID', 'LIQUID', 'SEND_ERROR')
    }
    return { paymentHash: assetHash, fee: Number(r?.fee ?? 0), amount: params.amount, status: 'pending' as TransactionStatus }
  }

  /** L-BTC on-chain send (alias of sendPayment's transfer). */
  async sendBtcOnchain(params: { address: string; amount: number; feeRate?: number }): Promise<any> {
    this.assertConnected()
    const r: any = await this.withLock(() =>
      this.account.transfer({ recipient: params.address, amount: params.amount, feeRate: params.feeRate })
    )
    const btcTxid: string = r?.hash ?? ''
    if (!btcTxid) {
      throw new ProtocolError('Liquid send did not return a transaction ID', 'LIQUID', 'SEND_ERROR')
    }
    return { txid: btcTxid, fee: Number(r?.fee ?? 0) }
  }

  // --- Transactions -------------------------------------------------------
  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    this.assertConnected()
    // Resolve the policy (L-BTC) asset id outside the lock (cached after first).
    let policy = await this.getPolicyAsset()
    const txs: Array<{
      txid: string
      type: string
      fee: string
      height: number | null
      timestamp: number | null
      balance?: Array<{ asset_id: string; value: string }>
    }> = await this.withLock(() => this.account.listTransactions())
    if (!policy) policy = this.inferPolicyAsset(txs)
    const mapped = txs.map((t) => {
      const isSend = t.type === 'outgoing'
      const fee = Number(t.fee ?? 0)
      const { assetId, amount } = this.primaryMovement(t.balance ?? [], policy, fee, isSend)
      const precision = assetId ? (KNOWN_ASSETS[assetId]?.precision ?? 8) : 8
      return {
        id: t.txid,
        type: (isSend ? 'send' : 'receive') as UnifiedTransaction['type'],
        status: (t.height != null ? 'confirmed' : 'pending') as TransactionStatus,
        timestamp: (t.timestamp ?? 0) * 1000,
        amount,
        amountDisplay: formatAmount(amount, precision),
        fee,
        asset: assetId ? this.txAsset(assetId, policy) : (undefined as unknown as UnifiedAsset),
        protocolData: { height: t.height, assetId, balance: t.balance },
      }
    })
    // Apply the TransactionFilter the signature accepts: predicates, then a
    // newest-first order, then offset/limit (audit finding G-F8).
    return applyTransactionFilter(mapped, filter)
  }

  /**
   * Pick the headline movement for a tx from lwk's signed per-asset deltas: a
   * non-L-BTC asset if one moved, else L-BTC. `amount` is a positive magnitude
   * (direction rides on the tx `type`); for an L-BTC send the fee is stripped,
   * since lwk's policy-asset delta includes it.
   */
  private primaryMovement(
    balance: Array<{ asset_id: string; value: string }>,
    policy: string,
    fee: number,
    isSend: boolean
  ): { assetId?: string; amount: number } {
    const deltas = balance
      .map((b) => ({ assetId: b.asset_id, value: Number(b.value) }))
      .filter((d) => Number.isFinite(d.value) && d.value !== 0)
    const nonPolicy = deltas.filter((d) => d.assetId !== policy)
    if (nonPolicy.length > 0) {
      const primary = nonPolicy.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a))
      return { assetId: primary.assetId, amount: Math.abs(primary.value) }
    }
    const policyDelta = deltas.find((d) => d.assetId === policy)
    if (!policyDelta) return { amount: 0 }
    const magnitude = Math.abs(policyDelta.value)
    return { assetId: policy, amount: isSend ? Math.max(0, magnitude - fee) : magnitude }
  }

  /** Infer L-BTC only when outgoing fee deltas make one asset unambiguous. */
  private inferPolicyAsset(
    txs: Array<{
      type: string
      fee: string
      balance?: Array<{ asset_id: string; value: string }>
    }>,
  ): string {
    const outgoing = txs.filter((tx) => tx.type === 'outgoing')
    const exactFeeAssets = new Set<string>()
    const negativeSets: Array<Set<string>> = []
    for (const tx of outgoing) {
      const fee = Number(tx.fee ?? 0)
      const negatives = (tx.balance ?? [])
        .map((delta) => ({ assetId: delta.asset_id, value: Number(delta.value) }))
        .filter((delta) => Number.isFinite(delta.value) && delta.value < 0)
      if (negatives.length === 0) continue
      negativeSets.push(new Set(negatives.map((delta) => delta.assetId)))
      if (Number.isFinite(fee) && fee > 0) {
        for (const delta of negatives) {
          if (Math.abs(delta.value) === fee) exactFeeAssets.add(delta.assetId)
        }
      }
    }
    if (exactFeeAssets.size === 1) return [...exactFeeAssets][0]
    if (negativeSets.length === 0) return ''
    const common = [...negativeSets[0]].filter((assetId) =>
      negativeSets.every((assets) => assets.has(assetId)),
    )
    return common.length === 1 ? common[0] : ''
  }

  /** Builds a metadata-only UnifiedAsset (balance 0) for a tx's asset id. */
  private txAsset(assetId: string, policy: string): UnifiedAsset {
    if (assetId === policy) {
      return this.toUnifiedAsset(assetId, 0n, {
        ticker: 'L-BTC',
        name: 'Liquid Bitcoin',
        precision: 8,
        layer: 'BTC_LIQUID',
      })
    }
    const meta = KNOWN_ASSETS[assetId]
    return this.toUnifiedAsset(assetId, 0n, {
      ticker: meta?.ticker ?? assetId.slice(0, 6),
      name: meta?.name ?? 'Liquid asset',
      precision: meta?.precision ?? 8,
      layer: 'LIQUID_ASSET',
    })
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    const all = await this.listTransactions()
    const found = all.find((t) => t.id === txId)
    if (!found) throw new ProtocolError(`Unknown tx ${txId}`, 'LIQUID', 'NO_TX')
    return found
  }

  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    const all = await this.listTransactions()
    const found = all.find((t) => t.id === paymentHash)
    return {
      paymentHash,
      status: (found?.status ?? 'pending') as TransactionStatus,
      timestamp: found?.timestamp,
    }
  }

  // --- Node info ----------------------------------------------------------
  async getNodeInfo(): Promise<any> {
    this.assertConnected()
    return this.withLock(() => this.account.getNetworkInfo())
  }

  async getBtcBalanceConfirmed(): Promise<number> {
    return (await this.getBtcBalance()).total
  }

  /** Fee-rate hints (sat/vB) for the send UI. lwk returns bigints; normalize to number. */
  async getFeeRates(): Promise<{ normal: number; fast: number }> {
    this.assertConnected()
    const r: any = await this.withLock(() => this.manager.getFeeRates())
    return { normal: Number(r?.normal ?? 0), fast: Number(r?.fast ?? 0) }
  }

  // --- External PSET + Simplicity ----------------------------------------
  async getSimplicityCapabilities(): Promise<SimplicityCapabilities> {
    this.assertConnected()
    if (typeof this.account?.getSimplicityCapabilities !== 'function') {
      return {
        version: 'experimental-0.1',
        available: false,
        pset: { inspect: false, blind: false, sign: false, finalize: false },
        simplicity: { compile: false, derivePublicKey: false, finalizeTransaction: false },
      }
    }
    return this.withLock(() => this.account.getSimplicityCapabilities())
  }

  async inspectLiquidPset(psetBase64: string): Promise<LiquidPsetReview> {
    this.assertConnected()
    const inspect = this.requireExperimentalAccountMethod('inspectPset')
    return this.withLock(() => inspect(psetBase64))
  }

  async blindLiquidPset(psetBase64: string): Promise<string> {
    this.assertConnected()
    const blind = this.requireExperimentalAccountMethod('blindPset')
    return this.withLock(() => blind(psetBase64))
  }

  async signLiquidPset(request: LiquidPsetSignRequest): Promise<LiquidPsetSignResult> {
    this.assertConnected()
    const sign = this.requireExperimentalAccountMethod('signPset')
    return this.withLock(() => sign(request))
  }

  async finalizeLiquidPset(psetBase64: string): Promise<{ pset: string; transactionHex: string; txid: string }> {
    this.assertConnected()
    const finalize = this.requireExperimentalAccountMethod('finalizePset')
    return this.withLock(() => finalize(psetBase64))
  }

  async broadcastLiquidPset(psetBase64: string): Promise<{ txid: string }> {
    this.assertConnected()
    const broadcast = this.requireExperimentalAccountMethod('broadcastPset')
    return this.withLock(() => broadcast(psetBase64))
  }

  async deriveSimplicityPublicKey(derivationPath?: string): Promise<{ publicKey: string; derivationPath: string }> {
    this.assertConnected()
    const derive = this.requireExperimentalAccountMethod('deriveSimplicityPublicKey')
    return this.withLock(() => derive(derivationPath))
  }

  async compileSimplicityProgram(request: SimplicityCompileRequest): Promise<SimplicityCompileResult> {
    this.assertConnected()
    const compile = this.requireExperimentalAccountMethod('compileSimplicityProgram')
    return this.withLock(() => compile(request))
  }

  // --- Not applicable to Liquid (on-chain only, no LN/invoices) -----------
  async createInvoice(_request: InvoiceRequest): Promise<Invoice> {
    throw new ProtocolError('Liquid has no invoices — use getReceiveAddress', 'LIQUID', 'NOT_SUPPORTED')
  }
  async decodeInvoice(_invoice: string): Promise<DecodedInvoice> {
    throw new ProtocolError('Liquid has no invoices', 'LIQUID', 'NOT_SUPPORTED')
  }
  async listChannels(): Promise<any[]> {
    // A disconnected adapter must not answer as if this were the wallet's state:
    // a dashboard that skipped its own isConnected() gate renders "0 channels /
    // 0 transfers" for a locked wallet. `listChannels`' JSDoc conditions the empty
    // array on the PROTOCOL having no channels, not on being disconnected, and
    // every sibling read on these adapters already asserts (audit finding G-F9).
    this.assertConnected()
    return [] // no Lightning
  }
  async listPayments(): Promise<any> {
    return this.listTransactions()
  }
  async listTransfers(): Promise<any> {
    // Without this the null account produced an opaque `TypeError` instead of a
    // ProtocolError NOT_CONNECTED (audit finding G-F9).
    this.assertConnected()
    return this.withLock(() => this.account.listTransactions())
  }

  // --- helpers ------------------------------------------------------------
  /**
   * The network's policy asset (L-BTC), or a hard failure.
   *
   * `getPolicyAsset()` deliberately swallows a `getNetworkInfo()` failure into
   * `''` and leaves it uncached so the next call retries. That is fine as a
   * caching decision but NOT as an input to a balance or history view: with
   * `policy === ''`, `listAssets()` emitted the synthetic L-BTC entry under
   * `id: ''` AND the raw policy-asset entry from `account.listAssets()` (the
   * dedupe `if (a.asset_id === policy) continue` can never match), so the same
   * funds were listed twice. Fail loudly instead — a retryable error beats a
   * balance that double-counts (audit finding G-F14).
   *
   * Used by `listAssets` only. History keeps the soft lookup and falls back to an
   * unambiguous fee-delta inference, so a momentary outage does not hide activity.
   */
  private async requirePolicyAsset(): Promise<string> {
    const policy = await this.getPolicyAsset()
    if (!policy) {
      throw new ProtocolError(
        'Liquid network info unavailable — cannot identify the policy asset (L-BTC)',
        'LIQUID',
        'NETWORK_INFO_UNAVAILABLE',
      )
    }
    return policy
  }

  private async getPolicyAsset(): Promise<string> {
    if (this.policyAsset) return this.policyAsset
    let policy = ''
    try {
      const info = await this.account.getNetworkInfo()
      policy = info?.policy_asset ?? ''
    } catch {
      /* network info unavailable — return '' and leave uncached so it retries */
    }
    if (policy) this.policyAsset = policy // only cache a real value
    return policy
  }

  private toUnifiedAsset(
    id: string,
    balance: bigint,
    meta: { ticker: string; name: string; precision: number; layer: Layer }
  ): UnifiedAsset {
    const n = Number(balance)
    return {
      id,
      name: meta.name,
      ticker: meta.ticker,
      precision: meta.precision,
      protocol: 'LIQUID',
      layer: meta.layer,
      balance: { total: n, available: n, pending: 0, totalDisplay: formatAmount(n, meta.precision), availableDisplay: formatAmount(n, meta.precision) },
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
