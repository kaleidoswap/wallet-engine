/**
 * LiquidWdkAdapter
 * ----------------
 * Wraps the WDK Liquid module (@kaleidorg/wdk-wallet-liquid, over lwk / Liquid Wallet
 * Kit) onto the stable `IProtocolAdapter` contract. This is the "USD" path: USDt on
 * Liquid is the lite-mode "USD" asset.
 *
 * Liquid is on-chain only — no Lightning, no invoices. Receive = an address.
 * Unlike Spark, the module exposes `listAssets()` + `getTokenBalance()`, so asset
 * enumeration (incl. USDt) works natively with no upstream gap.
 *
 * Discipline: no WDK/lwk types cross the contract — everything returned is a domain
 * type from ../types/base; WDK objects are held as `any`.
 *
 * WDK Liquid surface (from types/index.d.ts):
 *   manager: getAccount, getAccountByPath, getFeeRates({normal,fast}: bigint), dispose
 *   account: getAddress(): string, getBalance(): bigint, getTokenBalance(id): bigint,
 *            transfer({recipient,amount,feeRate?}), sendAsset({assetId,recipient,amount,feeRate?}),
 *            listAssets(): {asset_id,balance}[], listUnspents, listTransactions,
 *            getNetworkInfo(): {network,policy_asset,address,tip_height}, sign, dispose
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
import { PROTOCOL_OPERATIONS } from '../../capabilities/operations'
import { loadWdkModule } from './moduleLoader'
import { BaseWdkAdapter } from './BaseWdkAdapter'

// Re-exported from the neutral constants module so core (disclosure) never has
// to import this adapter to reach the asset id.
export { LIQUID_USDT_ASSET_ID } from '../../constants'
import { LIQUID_USDT_ASSET_ID } from '../../constants'
import { formatAmount } from '../../lib/amount'

export interface LiquidSyncWarning {
  code: 'LIQUID_WATERFALLS_FALLBACK'
  message: string
  details?: { reason?: 'waterfalls_failed' }
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
   * Use the server-side "waterfalls" scan (one request) instead of a client-side gap-limit scan
   * (~40 requests → ~10s cold). Requires `esploraUrl` to point at a waterfalls-capable server;
   * public Blockstream Esplora is not one. Default: false.
   */
  waterfalls?: boolean
  /**
   * Explicitly allow a one-time retry through the network's built-in standard Esplora provider
   * if Waterfalls fails. This changes providers and may disclose wallet addresses/scripts to it.
   */
  allowDefaultEsploraFallback?: boolean
  /** Optional waterfalls server recipient key; encrypts the descriptor before it is sent. */
  waterfallsRecipient?: string
  /** Receives non-fatal sync warnings, including successful Waterfalls fallback. */
  onWarning?: (warning: LiquidSyncWarning) => void | Promise<void>
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
  readonly capabilities = PROTOCOL_OPERATIONS.LIQUID
  readonly supportedLayers: Layer[] = getCapabilities('LIQUID').layers

  private policyAsset: string | null = null

  // lwk's Wollet is NOT re-entrant: while one call is awaiting its Esplora sync,
  // a second call into the same wasm object panics with "recursive use of an
  // object … unsafe aliasing in rust". The dashboard fires balance + listAssets +
  // address concurrently, so serialize every lwk operation onto one queue.
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

  // --- Connection ---------------------------------------------------------
  async connect(config: LiquidAdapterConfig): Promise<void>
  async connect(config: BaseProtocolConfig): Promise<void>
  async connect(config: BaseProtocolConfig): Promise<void> {
    const cfg = config as LiquidAdapterConfig
    if (!cfg.mnemonic) {
      throw new ProtocolError('LiquidWdkAdapter requires a mnemonic', 'LIQUID', 'CONFIG')
    }
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
      const policy = await this.getPolicyAsset()
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
    return {
      paymentHash: r?.hash ?? '',
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
    return { paymentHash: r?.hash ?? '', fee: Number(r?.fee ?? 0), amount: params.amount, status: 'pending' as TransactionStatus }
  }

  /** L-BTC on-chain send (alias of sendPayment's transfer). */
  async sendBtcOnchain(params: { address: string; amount: number; feeRate?: number }): Promise<any> {
    this.assertConnected()
    const r: any = await this.withLock(() =>
      this.account.transfer({ recipient: params.address, amount: params.amount, feeRate: params.feeRate })
    )
    return { txid: r?.hash ?? '', fee: Number(r?.fee ?? 0) }
  }

  // --- Transactions -------------------------------------------------------
  async listTransactions(_filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    this.assertConnected()
    // Resolve the policy (L-BTC) asset id outside the lock (cached after first).
    const policy = await this.getPolicyAsset()
    const txs: Array<{
      txid: string
      type: string
      fee: string
      height: number | null
      timestamp: number | null
      balance?: Array<{ asset_id: string; value: string }>
    }> = await this.withLock(() => this.account.listTransactions())
    return txs.map((t) => {
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
  }

  /**
   * Picks the "headline" movement for a tx from lwk's signed per-asset deltas:
   * a non-L-BTC asset (e.g. USDt) if one moved, else L-BTC. Returned `amount`
   * is a positive magnitude (direction is carried by the tx `type`); for an
   * L-BTC send the fee is stripped since lwk's policy-asset delta includes it.
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

  // --- Not applicable to Liquid (on-chain only, no LN/invoices) -----------
  async createInvoice(_request: InvoiceRequest): Promise<Invoice> {
    throw new ProtocolError('Liquid has no invoices — use getReceiveAddress', 'LIQUID', 'NOT_SUPPORTED')
  }
  async decodeInvoice(_invoice: string): Promise<DecodedInvoice> {
    throw new ProtocolError('Liquid has no invoices', 'LIQUID', 'NOT_SUPPORTED')
  }
  async listChannels(): Promise<any[]> {
    return [] // no Lightning
  }
  async listPayments(): Promise<any> {
    return this.listTransactions()
  }
  async listTransfers(): Promise<any> {
    return this.withLock(() => this.account.listTransactions())
  }

  // --- helpers ------------------------------------------------------------
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
