/**
 * ArkadeWdkAdapter
 * ----------------
 * Arkade on the `IProtocolAdapter` contract. Arkade is a VTXO-based Bitcoin L2:
 * off-chain Ark transfers, an on-chain "boarding" address for funding, and
 * Lightning via Boltz swaps.
 *
 * Built on `@arkade-os/sdk` **directly**. It used to wrap `@arkade-os/wdk`,
 * which hard-pins the SDK at exactly `0.4.35` and so held the Arkade path
 * behind everything the SDK learned after it — per-connection `EventSource`
 * injection among them, which is what settlement needs. The reference wallet
 * (`arkade-os/wallet`) uses the SDK directly too.
 *
 * The class name is unchanged on purpose: it is what hosts import, and a rename
 * is a migration they would have to make for no behavioural gain. The `wdk`
 * path in this directory is likewise where consumers already point.
 *
 * Identities derive `WDK_COMPAT` (see `lib/arkade-identity`), so every wallet
 * this adapter created before the move keeps its addresses. That equivalence is
 * verified byte-for-byte against live wallets; it is what made the move safe.
 *
 * No `@arkade-os` type crosses the contract, and the SDK is lazy-loaded in
 * `connect()` so this sub-path stays SDK-free until used.
 */

import { IProtocolAdapter, BaseProtocolConfig } from '../IProtocolAdapter'
import {
  ProtocolType,
  Layer,
  NodeInfo,
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
import { BaseWdkAdapter } from './BaseWdkAdapter'
import { PROTOCOL_OPERATIONS } from '../../capabilities/operations'
import { loadWdkModule } from './moduleLoader'
import { ensureEventSource, EVENT_SOURCE_MISSING_REASON } from '../../lib/arkade-eventsource'
import { createArkadeSdkWallet, flattenArkadeConfig } from '../../lib/arkade-sdk-wallet'
import { NON_PERSISTENT_STORAGE_REASON } from '../../lib/arkade-storage'
import { runArkadeVtxoLifecycle } from '../../lib/arkade-vtxo-lifecycle'
import { decodeBolt11, isBolt11 } from '../../lib/bolt11'
import { normalizeVtxos, sortVtxosByExpiry, toNumber, formatSats, formatUnits } from '../../lib/arkade-helpers'
import { signLnMessage, verifyLnMessage } from '../../lib/ln-message-sign'
import { resolveWalletSeed } from '../../lib/wallet-seed'
import { applyTransactionFilter } from '../../lib/transaction-filter'

const isBitcoinAddress = (value: string): boolean => /^(bc1|tb1|bcrt1)/i.test(value.trim())
const isLightningInvoice = (value: string): boolean => {
  const body = value.trim().toLowerCase().replace(/^lightning:/, '')
  return /^ln(bc|tb|bcrt|sb)/.test(body)
}

const ARKADE_TRANSACTION_BTC: UnifiedAsset = {
  id: 'BTC',
  name: 'Bitcoin (Arkade)',
  ticker: 'BTC',
  precision: 8,
  protocol: 'ARKADE',
  layer: 'BTC_ARKADE',
  balance: {
    total: 0,
    available: 0,
    pending: 0,
    locked: 0,
    totalDisplay: formatSats(0),
    availableDisplay: formatSats(0),
  },
  capabilities: {
    canSend: true,
    canReceive: true,
    canSwap: false,
    supportsLightning: false,
    supportsOnchain: true,
  },
}

export interface ArkadeAdapterConfig extends BaseProtocolConfig {
  protocol: 'ARKADE'
  /** BIP-39 mnemonic for this wallet. */
  mnemonic: string
  /** BIP-44 account index (default 0). */
  accountIndex?: number
  /** Arkade wallet config (ark server URL, indexer URL, swap provider URL, …) passed through to the module. */
  arkadeConfig?: Record<string, any>
}

/**
 * Operations reachable via `executeProtocolOperation`, and where each is served.
 *
 * The base class dispatches an allowlist against a WDK account; there isn't one
 * any more, so Arkade routes its own. Splitting by owner is the point: the
 * Lightning operations only exist when a swap provider is configured, and
 * saying so beats a `TypeError` from an absent method.
 *
 * VTXO-lifecycle ops are typed adapter methods, so intentionally not here.
 */
const ARKADE_SWAP_OPS: ReadonlySet<string> = new Set([
  'waitForLightningPayment',
  'getLightningLimits',
  'getLightningFees',
])
const ARKADE_WALLET_OPS: ReadonlySet<string> = new Set([
  'notifyIncomingFunds',
  'getBoardingAddress',
  'getTransactionHistory',
])

export class ArkadeWdkAdapter extends BaseWdkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'ARKADE'
  readonly capabilities = PROTOCOL_OPERATIONS.ARKADE
  readonly supportedLayers: Layer[] = getCapabilities('ARKADE').layers


  /** Lazily-loaded `@arkade-os/sdk` (for Ramps onboard/offboard). Kept off the static import graph. */
  private arkSdk: any = null

  /** The `@arkade-os/sdk` Wallet. Built here, not reached into. */
  private wallet: any = null

  /** Boltz swaps client, when a swap provider is configured. */
  private swaps: any = null

  /** Cached `getInfo()` — the fee table the offchain estimates come from. */
  private arkInfo: any = null

  /**
   * Fee estimate for a send, from the operator's own rate.
   *
   * Reproduces `@arkade-os/wdk`'s `calculateOffchainFee` / `calculateOnchainFee`
   * — the same rate and the same assumed sizes (150 vB offchain; 165 vB
   * onchain, being one P2TR input, two P2TR outputs and overhead) — so the
   * `fee` a caller reads off a `PaymentResult` does not change with this move.
   * An estimate, not what the transaction paid: that is what it always was.
   */
  private estimateFee(kind: 'offchain' | 'onchain'): number {
    const rate = parseFloat(String(this.arkInfo?.fees?.txFeeRate ?? ''))
    if (!Number.isFinite(rate) || rate < 0) return 0
    return Math.ceil((kind === 'offchain' ? 150 : 165) * rate)
  }

  private get rawWallet(): any {
    if (!this.wallet) throw new ProtocolError('Arkade wallet unavailable', 'ARKADE', 'NOT_CONNECTED')
    return this.wallet
  }

  /**
   * Connectedness is the SDK wallet now, not a WDK account.
   *
   * The base class asserts on `this.account`, which this adapter no longer
   * populates — inherited unchanged, every call would refuse as NOT_CONNECTED.
   */
  protected assertConnected(): void {
    if (!this.connected || !this.wallet) {
      throw new ProtocolError('ArkadeWdkAdapter not connected', 'ARKADE', 'NOT_CONNECTED')
    }
  }

  /**
   * Tear down the wallet and the swaps client.
   *
   * The base teardown disposes an account and a manager, and this adapter has
   * neither. Signing state is dropped before the fallible third-party cleanup
   * is awaited, same order as the base: a dispose that throws must not leave a
   * live wallet behind a `connected: false` flag.
   */
  async disconnect(): Promise<void> {
    const wallet = this.wallet
    const swaps = this.swaps
    this.wallet = null
    this.swaps = null
    this.arkInfo = null
    this.connected = false
    this.mnemonic = null

    const results = await Promise.allSettled([
      Promise.resolve().then(() => swaps?.dispose?.()),
      Promise.resolve().then(() => wallet?.dispose?.()),
    ])
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failure) throw failure.reason
  }

  // --- Connection ---------------------------------------------------------
  async connect(config: BaseProtocolConfig): Promise<void> {
    const cfg = config as ArkadeAdapterConfig & {
      arkServerUrl?: string
      esploraUrl?: string
      swapProviderUrl?: string
      indexerUrl?: string
      boltzSwapsEnabled?: boolean
      eventSource?: unknown
      delegatorUrl?: string
      delegationEnabled?: boolean
      storage?: { walletRepository: unknown; contractRepository: unknown }
    }
    if (!cfg.mnemonic) throw new ProtocolError('ArkadeWdkAdapter requires a mnemonic', 'ARKADE', 'CONFIG')
    await this.releasePreviousConnection()
    this.mnemonic = cfg.mnemonic
    this.network = cfg.network ?? 'mainnet'
    // Accept an explicit `arkadeConfig` passthrough OR the native adapter's flat
    // fields, so hosts can switch adapters without reshaping their connect config.
    // Settings may arrive at the top level or nested under `arkadeConfig`;
    // hosts use both. See `flattenArkadeConfig`.
    const flat = flattenArkadeConfig(cfg as Record<string, any>)
    const { arkServerUrl, esploraUrl, swapProviderUrl } = flat as {
      arkServerUrl?: string
      esploraUrl?: string
      swapProviderUrl?: string
    }

    // @ts-ignore — optional peer, resolved at runtime in the consuming app.
    this.arkSdk = await loadWdkModule('@arkade-os/sdk', () => import('@arkade-os/sdk'))

    const created = await createArkadeSdkWallet(this.arkSdk, {
      secret: cfg.mnemonic,
      network: this.network,
      accountIndex: cfg.accountIndex ?? 0,
      // The derivation `@arkade-os/wdk` used, so every wallet this adapter ever
      // created keeps its addresses. Verified byte-identical; see
      // `lib/arkade-identity`, and never change it without reading that file.
      derivation: 'WDK_COMPAT',
      arkServerUrl,
      esploraUrl,
      indexerUrl: flat.indexerUrl as string | undefined,
      delegatorUrl: flat.delegatorUrl as string | undefined,
      delegationEnabled: flat.delegationEnabled as boolean | undefined,
      storage: flat.storage as { walletRepository: unknown; contractRepository: unknown } | undefined,
      eventSource: flat.eventSource,
    })
    this.wallet = created.wallet
    this.storagePersistent = created.storagePersistent
    this.delegationEnabled = created.delegationEnabled
    this.delegatorUrl = flat.delegatorUrl as string | undefined
    this.eventSourceAvailable = created.eventSourceAvailable
    if (!this.eventSourceAvailable) console.warn(`[ArkadeWdkAdapter] ${EVENT_SOURCE_MISSING_REASON}`)

    this.arkInfo = await this.wallet.arkProvider.getInfo()

    // Boltz swaps, for the Lightning legs. Opt-in: `ArkadeSwaps.create` with a
    // swap manager opens a WebSocket that reconnects for the life of the
    // session, which is pure noise for a host reaching Lightning another way
    // (the same reasoning as #81, which the WDK path could not honour because
    // the WDK always started one).
    if (swapProviderUrl) {
      // @ts-ignore — optional peer, resolved at runtime.
      const boltz: any = await loadWdkModule('@arkade-os/boltz-swap', () => import('@arkade-os/boltz-swap'))
      const swapProvider = new boltz.BoltzSwapProvider({
        apiUrl: swapProviderUrl,
        network: this.arkInfo?.network,
        referralId: 'kaleidoswap-wallet-engine',
      })
      this.swaps = await boltz.ArkadeSwaps.create({
        wallet: this.wallet,
        swapProvider,
        ...(flat.boltzSwapsEnabled ? { swapManager: { autoStart: true, pollInterval: 5_000 } } : {}),
      })
    }
    this.connected = true
  }

  /** False when the runtime has no `EventSource`; see `lib/arkade-eventsource`. */
  private eventSourceAvailable = true

  /** False when VTXO/contract rows are in-memory; see `lib/arkade-storage`. */
  private storagePersistent = true

  /** True when a delegator is wired and will settle on this wallet's behalf. */
  private delegationEnabled = false

  /**
   * Everything this connection cannot do that a host would assume it can, and
   * that no call will fail to report. All three are silent by nature: the
   * wallet keeps answering, and the consequence arrives weeks later as funds
   * that are simply gone.
   */
  private degradations(): string[] {
    const reasons: string[] = []
    if (!this.eventSourceAvailable) reasons.push(EVENT_SOURCE_MISSING_REASON)
    if (!this.storagePersistent) reasons.push(NON_PERSISTENT_STORAGE_REASON)
    // Not delegating is not itself a fault — a host may settle on its own — but
    // with no delegator AND no event stream nothing can renew a VTXO at all.
    if (!this.delegationEnabled && !this.eventSourceAvailable) {
      reasons.push(
        'No delegator is configured and this runtime cannot settle for itself, so nothing will renew a VTXO before its batch expires. ' +
          'Set ArkadeConfig.delegatorUrl.',
      )
    }
    return reasons
  }

  /**
   * Run one VTXO-lifecycle pass: renew expiring VTXOs, report recoverable and
   * expired-boarding balances, and delegate spendable VTXOs when a delegator is
   * configured. Every stage is best-effort and isolated.
   *
   * Exposed because nothing else drives it on this adapter. The SDK's own
   * periodic settle covers the common case, and a host that wants to force a
   * pass — on resume, before a withdrawal, on a schedule it controls — had no
   * way to ask for one.
   */
  async runVtxoLifecycle(): Promise<Awaited<ReturnType<typeof runArkadeVtxoLifecycle>>> {
    this.assertConnected()
    const wallet = this.rawWallet
    return runArkadeVtxoLifecycle({
      vtxoManager: await wallet.getVtxoManager(),
      wallet,
      config: { delegationEnabled: this.delegationEnabled, delegatorUrl: this.delegatorUrl },
    })
  }

  /** Delegator endpoint in use, when delegation is on. */
  private delegatorUrl: string | undefined

  async getConnectionInfo(): Promise<ConnectionInfo> {
    this.assertConnected()
    return {
      protocol: 'ARKADE',
      connected: this.connected,
      network: this.network,
      syncStatus: { synced: true, progress: 100 },
      // `connected` on its own would let a host believe its funds are safe
      // while settlement is impossible and the batch expiry runs down.
      ...(this.degradations().length ? { degraded: this.degradations() } : {}),
    }
  }

  // --- Address / receive --------------------------------------------------
  /** Default Ark address. For the on-chain boarding address use `getBoardingAddress`. */
  async getReceiveAddress(assetId?: string): Promise<Address> {
    this.assertConnected()
    // 'onchain'/'boarding' → on-chain boarding address for funding.
    if (assetId === 'onchain' || assetId === 'boarding') {
      const address: string = await this.rawWallet.getBoardingAddress()
      return { address, format: 'BTC_ADDRESS', asset: 'BTC' }
    }
    const address: string = await this.rawWallet.getAddress()
    return { address, format: 'ARKADE_ADDRESS', asset: assetId && assetId !== 'BTC' ? assetId : 'BTC' }
  }

  /** On-chain BTC boarding address for funding the Arkade account. */
  async getBoardingAddress(): Promise<Address> {
    this.assertConnected()
    const address: string = await this.rawWallet.getBoardingAddress()
    return { address, format: 'BTC_ADDRESS' }
  }

  // --- Balance ------------------------------------------------------------
  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    this.assertConnected()
    const b = await this.getWalletBalanceSummary()
    // preconfirmed VTXOs are spendable, so `confirmed` = settled + preconfirmed.
    const confirmed = b.available
    return { confirmed, unconfirmed: Math.max(b.total - confirmed, 0), total: b.total }
  }

  async refreshBalances(): Promise<void> {
    // Arkade syncs against the indexer on read; no explicit sync call.
  }

  async listAssets(): Promise<UnifiedAsset[]> {
    this.assertConnected()
    const b = await this.getWalletBalanceSummary()
    const btc: UnifiedAsset = {
      id: 'BTC',
      name: 'Bitcoin (Arkade)',
      ticker: 'BTC',
      precision: 8,
      protocol: 'ARKADE',
      layer: 'BTC_ARKADE',
      balance: {
        total: b.total,
        available: b.available,
        pending: 0,
        locked: 0,
        totalDisplay: formatSats(b.total),
        availableDisplay: formatSats(b.available),
      },
      capabilities: { canSend: true, canReceive: true, canSwap: false, supportsLightning: false, supportsOnchain: true },
      metadata: { boarding: b.boardingTotal, settled: b.settled, preconfirmed: b.preconfirmed, recoverable: b.recoverable },
    }
    const out: UnifiedAsset[] = [btc]

    // Arkade tokens. The wallet's `getBalance()` includes `assets: { assetId, amount }[]`;
    // resolve metadata via `assetManager.getAssetDetails(assetId).metadata`.
    try {
      const wallet = this.rawWallet
      const rawBalance: any = wallet?.getBalance ? await wallet.getBalance() : null
      const rawAssets: any[] = Array.isArray(rawBalance?.assets) ? rawBalance.assets : []
      for (const entry of rawAssets) {
        const assetId = String(entry?.assetId ?? '')
        const amount = Number(entry?.amount ?? 0)
        if (!assetId || amount <= 0) continue
        let meta: any = {}
        try {
          meta = (await wallet?.assetManager?.getAssetDetails?.(assetId))?.metadata ?? {}
        } catch {
          /* metadata lookup is optional */
        }
        const decimals = Number(meta.decimals ?? 0) || 0
        const ticker = typeof meta.ticker === 'string' && meta.ticker.trim() ? meta.ticker : assetId.slice(0, 6)
        const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name : ticker
        out.push({
          id: assetId,
          name,
          ticker,
          precision: decimals,
          protocol: 'ARKADE',
          layer: 'ARKADE_ARKADE',
          balance: { total: amount, available: amount, pending: 0, totalDisplay: formatUnits(amount, decimals), availableDisplay: formatUnits(amount, decimals) },
          icon: typeof meta.icon === 'string' ? meta.icon : undefined,
          capabilities: { canSend: true, canReceive: true, canSwap: false, supportsLightning: false, supportsOnchain: false },
        })
      }
    } catch {
      /* token enumeration is best-effort — keep BTC even if unavailable */
    }
    return out
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    this.assertConnected()
    if (assetId === 'BTC' || assetId.toLowerCase() === 'btc') {
      const { balance } = await this.getAsset('BTC').then((a) => ({ balance: a.balance }))
      return balance
    }
    const balance = await this.rawWallet.getBalance()
    const entry = (balance?.assets ?? []).find((a: any) => a?.assetId === assetId)
    const n = Number(entry?.amount ?? 0n)
    const precision = (await this.listAssets()).find((a) => a.id === assetId)?.precision ?? 0
    return { total: n, available: n, pending: 0, totalDisplay: formatUnits(n, precision), availableDisplay: formatUnits(n, precision) }
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets()
    const found = assets.find((a) => a.id === assetId || a.ticker === assetId)
    if (!found) throw new ProtocolError(`Unknown asset ${assetId}`, 'ARKADE', 'NO_ASSET')
    return found
  }

  // --- Invoices -----------------------------------------------------------
  /** Honor the requested layer so Lightning callers never receive an Ark address. */
  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    this.assertConnected()
    if (request.layer === 'BTC_LN') return this.createArkadeLightningInvoice(request)
    const address: string = await this.rawWallet.getAddress()
    return {
      invoice: address,
      paymentHash: '',
      amount: request.amount,
      expiresAt: Date.now() + (request.expirySeconds ?? 3600) * 1000,
      description: request.description ?? 'Arkade receiving address',
    }
  }

  /**
   * Boltz reverse-swap Lightning invoice landing funds here as a VTXO. Requires
   * amount > 0 (Boltz can't issue an amountless invoice); the embedded SwapManager
   * claims the VHTLC once the payment settles.
   */
  async createArkadeLightningInvoice(request: InvoiceRequest): Promise<Invoice> {
    this.assertConnected()
    if (!request.amount || request.amount <= 0) {
      throw new ProtocolError('Amount is required for Boltz Lightning invoices into Arkade', 'ARKADE', 'INVALID_AMOUNT')
    }
    // createLightningInvoice(amountSats, description?) — POSITIONAL args; via Boltz reverse swap.
    if (!this.swaps?.createLightningInvoice) {
      throw new ProtocolError('Arkade Lightning receive needs a swapProviderUrl', 'ARKADE', 'NOT_SUPPORTED')
    }
    const r: any = await this.swaps.createLightningInvoice({
      amount: request.amount,
      description: request.description,
    })
    return {
      invoice: r?.invoice ?? '',
      paymentHash: r?.paymentHash ?? '',
      amount: request.amount,
      expiresAt: Date.now() + (request.expirySeconds ?? 3600) * 1000,
      description: request.description ?? 'Boltz reverse swap into Arkade',
    }
  }

  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    const dest = invoice.trim()
    if (isBolt11(dest)) {
      const { amountSat } = decodeBolt11(dest)
      return { paymentHash: '', amount: amountSat, expiresAt: 0, destination: dest }
    }
    return { paymentHash: '', expiresAt: 0, destination: dest }
  }

  // --- Send ---------------------------------------------------------------
  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    this.assertConnected()
    const dest = request.invoice.trim()

    // Lightning send via Boltz submarine swap (Arkade → Lightning), if the account exposes the swap client.
    if (isLightningInvoice(dest)) {
      const swaps: any = this.swaps
      if (!swaps?.sendLightningPayment) {
        throw new ProtocolError('Arkade Lightning send not available in this module version', 'ARKADE', 'NOT_SUPPORTED')
      }
      const invoiceBody = dest.toLowerCase().startsWith('lightning:') ? dest.slice('lightning:'.length) : dest
      try {
        const result: any = await swaps.sendLightningPayment({ invoice: invoiceBody })
        // A preimage is settlement proof, not the public history identifier.
        if (!result?.txid && !result?.preimage) {
          throw new ProtocolError(
            'Arkade Lightning send returned no transaction id and no preimage',
            'ARKADE',
            'SEND_ERROR',
          )
        }
        return {
          paymentHash: result?.txid ?? '',
          preimage: result?.preimage,
          amount: Number(result?.amount ?? request.amount ?? 0),
          fee: 0,
          status: 'pending',
          timestamp: Date.now(),
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        if (/less than minimal/i.test(msg)) {
          throw new ProtocolError(
            "Arkade can't pay amountless Lightning invoices. Ask the recipient for an invoice with an amount.",
            'ARKADE',
            'INVALID_AMOUNT',
          )
        }
        throw new ProtocolError(`Failed to send Lightning payment via Boltz: ${msg}`, 'ARKADE', 'SEND_PAYMENT_ERROR')
      }
    }

    if (request.amount == null) {
      throw new ProtocolError('Arkade send requires an explicit amount', 'ARKADE', 'NO_AMOUNT')
    }
    // Bitcoin destination → on-chain offboard. Route through sendBtcOnchain so the
    // missing-tx-id guard and async `pending` status apply regardless of entry point.
    if (isBitcoinAddress(dest)) {
      return this.sendBtcOnchain({ address: dest, amount: request.amount })
    }
    // Off-chain Ark transfer to an Ark address (settles immediately, zero-conf UX).
    const hash: string = await this.rawWallet.sendBitcoin({ address: dest, amount: request.amount })
    // A successful send must be traceable and reconcilable.
    if (!hash) {
      throw new ProtocolError('Arkade send did not return a transaction ID', 'ARKADE', 'SEND_ERROR')
    }
    return {
      paymentHash: hash,
      txid: hash,
      amount: request.amount,
      fee: this.estimateFee('offchain'),
      status: 'confirmed',
      timestamp: Date.now(),
    }
  }

  /** Arkade BTC send/offboard. Bitcoin destinations settle on-chain asynchronously. */
  async sendBtcOnchain(params: { address: string; amount: number; feeRate?: number }): Promise<PaymentResult> {
    this.assertConnected()
    const hash: string = await this.rawWallet.sendBitcoin({ address: params.address.trim(), amount: params.amount })
    if (!hash) {
      throw new ProtocolError('Arkade offboard did not return a transaction ID', 'ARKADE', 'SEND_ERROR')
    }
    return {
      txid: hash,
      paymentHash: hash,
      amount: params.amount,
      fee: this.estimateFee('onchain'),
      status: 'pending',
      timestamp: Date.now(),
    }
  }

  /** Arkade asset transfer (token). */
  async sendAsset(params: { token: string; recipient: string; amount: number }): Promise<any> {
    this.assertConnected()
    const txid: string = await this.rawWallet.send({
      address: params.recipient,
      assets: [{ assetId: params.token, amount: BigInt(params.amount) }],
    })
    return { hash: txid, txid }
  }

  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    this.assertConnected()
    try {
      // Arkade WDK's receipt is raw transaction hex (`string`), with no
      // confirmation fields. Transaction history is the declared source for
      // `settled`, amount and timestamp.
      const transaction = (await this.listTransactions()).find((tx) => tx.id === paymentHash)
      return {
        paymentHash,
        status: transaction?.status ?? 'pending',
        amount: transaction?.amount,
        timestamp: transaction?.timestamp,
      }
    } catch {
      return { paymentHash, status: 'unknown' }
    }
  }

  // --- Transactions -------------------------------------------------------
  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    this.assertConnected()
    const history: any[] = await this.rawWallet.getTransactionHistory()
    const mapped: UnifiedTransaction[] = (history ?? []).map((t) => {
      // ArkTransaction: { key:{arkTxid,commitmentTxid,boardingTxid}, type, amount,
      // settled, createdAt }. The txid lives on `key` — unused fields are empty
      // strings, so pick the first NON-EMPTY one (`??` would stop at `''`).
      // Direction is the explicit `type`.
      const key = t?.key ?? {}
      const id = t?.txid || key.arkTxid || key.commitmentTxid || key.boardingTxid || ''
      const isSend = String(t?.type ?? '').toUpperCase() === 'SENT'
      const createdAt = Number(t?.createdAt ?? 0)
      return {
        id,
        type: isSend ? 'send' : 'receive',
        status: (t?.settled || (!isSend && !key.boardingTxid) ? 'confirmed' : 'pending') as TransactionStatus,
        timestamp: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
        amount: Math.abs(Number(t?.amount ?? 0)),
        amountDisplay: '',
        asset: ARKADE_TRANSACTION_BTC,
        protocolData: t,
      }
    })
    // Apply the TransactionFilter the signature accepts: predicates, then a
    // newest-first order, then offset/limit (audit finding G-F8).
    return applyTransactionFilter(mapped, filter)
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    const all = await this.listTransactions()
    const found = all.find((t) => t.id === txId)
    if (!found) throw new ProtocolError(`Unknown tx ${txId}`, 'ARKADE', 'NO_TX')
    return found
  }

  // --- Node & balance -----------------------------------------------------
  async getNodeInfo(): Promise<NodeInfo> {
    this.assertConnected()
    const b = await this.getWalletBalanceSummary()
    const spendableSats = b.available
    return {
      channelsBalanceMsat: spendableSats * 1000,
      maxPayableMsat: spendableSats * 1000,
      onchainBalanceMsat: b.boardingConfirmed * 1000,
      pendingOnchainBalanceMsat: b.boardingUnconfirmed * 1000,
      maxReceivableMsat: 0,
      inboundLiquidityMsats: 0,
      connectedPeers: [],
      utxos: 0,
    }
  }

  async listChannels(): Promise<any[]> {
    // Distinguish an unsupported channel model from an unavailable wallet.
    this.assertConnected()
    return [] // Arkade has no LN channels (LN via Boltz swaps)
  }

  async listPayments(): Promise<any> {
    const txs = await this.listTransactions()
    return { payments: txs }
  }

  async listTransfers(): Promise<any> {
    this.assertConnected()
    return { transfers: [] }
  }

  // --- VTXO lifecycle -----------------------------------------------------
  /** All VTXOs, sorted by batchExpiry ascending (expiry-first) so soon-to-expire coins surface first. */
  async getVtxos(): Promise<Record<string, unknown>[]> {
    this.assertConnected()
    const vtxos = await this.rawWallet.getVtxos()
    return normalizeVtxos(sortVtxosByExpiry(vtxos)).map((vtxo) => ({
      txid: vtxo.txid,
      vout: vtxo.vout,
      value: vtxo.value,
      state: vtxo.state,
      batchTxid: vtxo.batchTxid,
      batchExpiry: vtxo.batchExpiry,
      createdAt: vtxo.createdAt,
      assets: vtxo.assets,
    }))
  }

  async getBoardingUtxos(): Promise<Record<string, unknown>[]> {
    this.assertConnected()
    const utxos: any[] = await this.rawWallet.getBoardingUtxos()
    return (utxos ?? []).map((u: any) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      confirmed: u.status?.confirmed ?? false,
    }))
  }

  /** Onboard — settle confirmed boarding UTXOs into VTXOs via a Commitment Transaction. */
  async onboard(): Promise<{ txid: string }> {
    this.assertConnected()
    const wallet = this.rawWallet
    const info = await wallet.arkProvider.getInfo()
    const commitmentTxid: string = await new this.arkSdk.Ramps(wallet).onboard(info.fees)
    return { txid: commitmentTxid }
  }

  /** Offboard — collaborative exit: convert VTXOs back to an on-chain Bitcoin UTXO. */
  async offboard(address: string, amount?: number): Promise<{ txid: string }> {
    this.assertConnected()
    if (!address) throw new ProtocolError('Destination address required for offboard', 'ARKADE', 'INVALID_ADDRESS')
    if (amount !== undefined && (!Number.isInteger(amount) || amount <= 0)) {
      throw new ProtocolError(`Invalid offboard amount: ${amount}`, 'ARKADE', 'INVALID_AMOUNT')
    }
    const wallet = this.rawWallet
    const info = await wallet.arkProvider.getInfo()
    const exitTxid: string = await new this.arkSdk.Ramps(wallet).offboard(
      address,
      info.fees,
      amount !== undefined ? BigInt(amount) : undefined,
    )
    return { txid: exitTxid }
  }

  // --- Message signing ----------------------------------------------------
  async signMessage(message: string): Promise<string> {
    this.assertConnected()
    if (!this.mnemonic) throw new ProtocolError('Wallet mnemonic not available', 'ARKADE', 'NOT_CONNECTED')
    const { HDKey } = await import('@scure/bip32')
    const seed = resolveWalletSeed(this.mnemonic)
    const node = HDKey.fromMasterSeed(seed).derive("m/138'/1")
    if (!node.privateKey) {
      throw new ProtocolError('Failed to derive message-signing key', 'ARKADE', 'KEY_DERIVATION_ERROR')
    }
    return signLnMessage(message, node.privateKey)
  }

  async verifyMessage(message: string, signature: string): Promise<string> {
    return verifyLnMessage(message, signature)
  }

  /** Escape hatch for Arkade-specific ops (waitForLightningPayment, getLightningLimits, …) — allowlisted. */
  async executeProtocolOperation(operation: string, params: any): Promise<any> {
    this.assertConnected()
    if (ARKADE_SWAP_OPS.has(operation)) {
      if (!this.swaps) {
        throw new ProtocolError(
          `Arkade operation '${operation}' needs a swapProviderUrl`,
          'ARKADE',
          'NOT_SUPPORTED',
        )
      }
      return this.callOn(this.swaps, operation, params)
    }
    if (ARKADE_WALLET_OPS.has(operation)) return this.callOn(this.rawWallet, operation, params)
    throw new ProtocolError(`ARKADE operation not allowed: '${operation}'`, 'ARKADE', 'NO_OP')
  }

  /** Invoke an allowlisted method on its owner, or say which one is missing. */
  private async callOn(target: any, operation: string, params: unknown): Promise<any> {
    const fn = target?.[operation]
    if (typeof fn !== 'function') {
      throw new ProtocolError(`Unknown ARKADE operation '${operation}'`, 'ARKADE', 'NO_OP')
    }
    return fn.call(target, params)
  }

  // --- Private helpers ----------------------------------------------------
  /**
   * Rich balance summary from VTXOs + boarding UTXOs. The SDK's `balance.total`
   * omits the boarding portion, so recompute: available = settled + preconfirmed;
   * total includes boarding + recoverable.
   */
  private async getWalletBalanceSummary(): Promise<{
    boardingConfirmed: number
    boardingUnconfirmed: number
    boardingTotal: number
    settled: number
    preconfirmed: number
    available: number
    recoverable: number
    total: number
  }> {
    const wallet = this.rawWallet
    const balance: any = await wallet.getBalance()
    const normalized = {
      boardingConfirmed: toNumber(balance?.boarding?.confirmed),
      boardingUnconfirmed: toNumber(balance?.boarding?.unconfirmed),
      boardingTotal: toNumber(balance?.boarding?.total),
      settled: toNumber(balance?.settled),
      preconfirmed: toNumber(balance?.preconfirmed),
      available: toNumber(balance?.available),
      recoverable: toNumber(balance?.recoverable),
      total: toNumber(balance?.total),
    }

    let normalizedVtxos: ReturnType<typeof normalizeVtxos> = []
    try {
      normalizedVtxos = normalizeVtxos(await wallet.getVtxos())
    } catch {
      /* fall back to wallet.getBalance() */
    }
    if (normalizedVtxos.length === 0) {
      const available = normalized.settled + normalized.preconfirmed
      return { ...normalized, available, total: normalized.boardingTotal + available + normalized.recoverable }
    }

    const vtxoSummary = normalizedVtxos.reduce(
      (summary, vtxo) => {
        if (vtxo.state === 'swept') summary.recoverable += vtxo.value
        else if (vtxo.state === 'preconfirmed') summary.preconfirmed += vtxo.value
        else summary.settled += vtxo.value
        return summary
      },
      { settled: 0, preconfirmed: 0, recoverable: 0 },
    )
    const available = vtxoSummary.settled + vtxoSummary.preconfirmed
    return {
      ...normalized,
      settled: vtxoSummary.settled,
      preconfirmed: vtxoSummary.preconfirmed,
      available,
      recoverable: vtxoSummary.recoverable,
      total: normalized.boardingTotal + available + vtxoSummary.recoverable,
    }
  }
}
