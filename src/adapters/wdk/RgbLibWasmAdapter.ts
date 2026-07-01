/**
 * RgbLibWasmAdapter
 * -----------------
 * RGB-L1 (on-chain) backed by the BROWSER/WASM rgb-lib build
 * (`@utexo/rgb-lib-wasm`) instead of the native addon used by
 * `RgbLibWdkAdapter`. Same protocol surface (BTC on-chain + RGB assets on-chain,
 * NO Lightning/channels/swaps), same `RgbCore` translation — only the backing
 * differs, so the two cannot drift on asset/balance shape.
 *
 * Why a separate adapter: the native `@utexo/wdk-wallet-rgb` needs a filesystem
 * `dataDir` + a Node/Bare runtime and cannot load in a browser / MV3 service
 * worker. The wasm build is a wasm-bindgen `--target web` module that persists to
 * IndexedDB and uses only fetch / crypto / WebAssembly — so it runs node-less in
 * the extension (and on mobile). It is the path that makes self-custodial RGB-L1
 * possible without an rgb-lightning-node.
 *
 * Runtime-agnostic: the host injects an ALREADY-wasm-initialized module via
 * `registerWdkModule('@utexo/rgb-lib-wasm', () => initializedModule)`. The host
 * owns where the 13 MB `_bg.wasm` comes from (`chrome.runtime.getURL(...)` in the
 * extension; a bundled asset on mobile) and must have awaited the default
 * `init(...)` export before injecting. This adapter never touches `fetch`/URLs.
 *
 * Discipline: no rgb-lib/wasm types cross the contract — the module + wallet are
 * read as `any` and translated. Field names are read defensively and should be
 * smoke-tested on-device (validated offline: keys, wallet, address, listAssets).
 *
 * WasmWallet API used (from @utexo/rgb-lib-wasm@1.0.0-beta.2):
 *   static create(walletDataJson) → WasmWallet (IndexedDB-restoring)
 *   goOnline(skipConsistencyCheck, indexerUrl) → online
 *   getAddress() · getBtcBalance() · getAssetBalance(id) · listAssets(schemas[])
 *   blindReceive(assetId|null, assignment, duration|null, transportEndpoints, minConf)
 *   sendBegin(online, recipientMap, donation, feeRate, minConf) · signPsbt(psbt)
 *     · sendEnd(online, signedPsbt, skipSync)
 *   sendBtcBegin/sendBtcEnd · createUtxosBegin/createUtxosEnd · refresh · sync
 *   listTransactions() · listTransfers(assetId?)
 * Top-level: init() (panic/log hook) · restoreKeys(network, mnemonic) → keys.
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
  NodeInfo,
  ProtocolError,
} from '../../types/base'
import { getCapabilities } from '../../capabilities'
import { PROTOCOL_OPERATIONS } from '../../capabilities/operations'
import { loadWdkModule } from './moduleLoader'
import { rgbBtcAsset, rgbNiaAsset, rgbAssetBalance, RGB_L1_PROFILE } from './RgbCore'
import type { RgbBalanceLike } from './RgbCore'
import { BaseWdkAdapter } from './BaseWdkAdapter'

export interface RgbLibWasmAdapterConfig extends BaseProtocolConfig {
  protocol: 'RGB_L1'
  /** BIP-39 mnemonic for this wallet. */
  mnemonic: string
  /** RGB indexer (electrum/esplora) URL — required to go online. */
  indexerUrl: string
  /**
   * RGB proxy / transport endpoints used when generating blinded receive
   * invoices. Optional; rgb-lib uses its defaults when omitted.
   */
  transportEndpoints?: string[]
  /**
   * Namespace key for this wallet's IndexedDB store (rgb-lib's `dataDir`). Lets
   * multiple wallets/networks coexist; defaults to a network-scoped name.
   */
  dataDir?: string
  /** Max allocations per UTXO (rgb-lib tuning). Defaults to 5. */
  maxAllocationsPerUtxo?: number
}

/** Map the engine network string → rgb-lib's network enum casing. */
function toRgbNetwork(network: string): string {
  switch (network.toLowerCase()) {
    case 'mainnet':
    case 'bitcoin':
      return 'Mainnet'
    case 'testnet':
      return 'Testnet'
    // KaleidoSwap's signet IS the custom signet (Mutinynet); its recipient IDs
    // are network-tagged `SignetCustom` and won't validate against a standard
    // `Signet` wallet (and vice-versa). Map both the explicit custom aliases and
    // the plain `signet` we surface in the UI to rgb-lib's `SignetCustom`.
    case 'signet':
    case 'signetcustom':
    case 'customsignet':
    case 'mutinynet':
      return 'SignetCustom'
    case 'regtest':
      return 'Regtest'
    default:
      return 'Mainnet'
  }
}

/**
 * Wrap a WasmWallet so every method call is queued and runs to completion before
 * the next starts — rgb-lib-wasm is single-threaded and corrupts/panics on
 * concurrent (interleaved-async) access. All methods become async; call sites
 * await them.
 */
function serializeWasmAccount<T extends object>(account: T): T {
  let chain: Promise<unknown> = Promise.resolve()
  return new Proxy(account, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const run = chain.then(() => (value as (...a: unknown[]) => unknown).apply(target, args))
        chain = run.then(
          () => undefined,
          () => undefined,
        )
        return run
      }
    },
  }) as T
}

export class RgbLibWasmAdapter extends BaseWdkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'RGB_L1'
  readonly capabilities = PROTOCOL_OPERATIONS.RGB_L1
  readonly supportedLayers: Layer[] = getCapabilities('RGB_L1').layers
  override readonly version = '0.1.0-wasm'

  /** The rgb-lib `online` handle returned by goOnline(); required by network ops. */
  private online: any = null
  private transportEndpoints: string[] = []

  // --- Connection ---------------------------------------------------------
  async connect(config: BaseProtocolConfig): Promise<void> {
    const cfg = config as RgbLibWasmAdapterConfig
    if (!cfg.mnemonic) throw new ProtocolError('RgbLibWasmAdapter requires a mnemonic', 'RGB_L1', 'CONFIG')
    if (!cfg.indexerUrl) throw new ProtocolError('RgbLibWasmAdapter requires an indexerUrl', 'RGB_L1', 'CONFIG')
    this.network = cfg.network ?? 'mainnet'
    this.transportEndpoints = cfg.transportEndpoints ?? []
    const rgbNetwork = toRgbNetwork(this.network)

    // The host injects an already-wasm-initialized module; the inline import is
    // the Node/Vite fallback. `init()` is rgb-lib's panic/log hook (idempotent).
    // @ts-ignore — declared as an optional dep; resolved at runtime.
    const mod = await loadWdkModule('@utexo/rgb-lib-wasm', () => import('@utexo/rgb-lib-wasm'))
    try {
      mod.init?.()
    } catch {
      /* already initialized */
    }

    const keys = mod.restoreKeys(rgbNetwork, cfg.mnemonic)
    const walletData = {
      // Scope the IndexedDB store by the rgb-lib network, NOT the host network
      // label: rgb-lib panics ("unreachable") if a store created under one
      // BitcoinNetwork is reopened under another (e.g. Signet → SignetCustom).
      // Distinct networks ⇒ distinct stores; same network ⇒ persistent.
      dataDir: cfg.dataDir ?? `rgb-l1-${rgbNetwork.toLowerCase()}`,
      bitcoinNetwork: rgbNetwork,
      databaseType: 'Sqlite', // the enum value the wasm build accepts; IndexedDB is the actual backing
      maxAllocationsPerUtxo: cfg.maxAllocationsPerUtxo ?? 5,
      mnemonic: keys.mnemonic ?? cfg.mnemonic,
      masterFingerprint: keys.masterFingerprint ?? keys.master_fingerprint,
      accountXpubVanilla: keys.accountXpubVanilla ?? keys.account_xpub_vanilla,
      accountXpubColored: keys.accountXpubColored ?? keys.account_xpub_colored,
      vanillaKeychain: null,
      supportedSchemas: ['Nia', 'Ifa'],
    }

    const WasmWallet = mod.WasmWallet
    const rawWallet = WasmWallet.create
      ? await WasmWallet.create(JSON.stringify(walletData))
      : new WasmWallet(JSON.stringify(walletData))
    // rgb-lib-wasm is single-threaded and NOT reentrant: if a second op starts
    // while an async one (refresh/sync/send/…) is mid-flight, its thread-locals
    // corrupt and it panics ("Lazy instance poisoned" → RuntimeError:
    // unreachable). Serialize every wallet call through a queue so they never
    // overlap. (Method results are awaited at each call site.)
    this.account = serializeWasmAccount(rawWallet)
    this.online = await this.account.goOnline(false, cfg.indexerUrl)
    this.connected = true
    await this.recoverBtcStateIfThin()
  }

  /**
   * One-time recovery for a wallet restored from a *thin* BDK snapshot (no
   * revealed SPKs) — the state left behind when an MV3 service-worker teardown
   * interrupts rgb-lib-wasm's async IndexedDB save. In that state an incremental
   * `sync` can only re-query already-revealed SPKs, so it can't rediscover the
   * on-chain BTC and the balance reads 0 even though funds exist.
   *
   * Strategy: after an incremental sync, if BTC still reads 0, run a `fullScan`
   * (BIP44 stop-gap) to rebuild the UTXO set from the indexer, then `flush` so
   * the recovered state durably persists (and normal incremental sync suffices
   * from then on). Version-guarded — `fullScan` is absent on rgb-lib-wasm
   * ≤ beta.2 — and best-effort so a scan failure never blocks connect.
   */
  private async recoverBtcStateIfThin(): Promise<void> {
    const fullScan = (this.account as { fullScan?: unknown } | null)?.fullScan
    if (typeof fullScan !== 'function') return
    try {
      await this.account.sync(this.online)
      const { total } = await this.getBtcBalance()
      if (total > 0) return // state already healthy — skip the costlier full scan
      await (this.account as { fullScan: (online: unknown) => Promise<void> }).fullScan(this.online)
      await this.flushState()
    } catch (e) {
      console.error('[RGB-L1] BTC state recovery scan failed:', e)
    }
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    this.assertConnected()
    return { protocol: 'RGB_L1', connected: this.connected, network: this.network }
  }

  // --- Address / receive --------------------------------------------------
  async getReceiveAddress(assetId?: string): Promise<Address> {
    this.assertConnected()
    // Only a real RGB asset id (rgb:…) yields a blinded invoice; BTC / "BTC" /
    // empty must return the on-chain BTC address (otherwise the BTC tab shows an
    // empty "bitcoin:" QR).
    if (assetId && assetId.startsWith('rgb:')) {
      const inv = await this.receiveRgb({ assetId })
      return { address: inv?.invoice ?? inv?.recipient_id ?? '', format: 'RGB_INVOICE', asset: assetId }
    }
    const address: string = await this.account.getAddress()
    return { address, format: 'BTC_ADDRESS' }
  }

  // --- Balance ------------------------------------------------------------
  /** Raw vanilla / colored BTC split as rgb-lib reports it (both in sats). */
  private async detailedBtcBalance(): Promise<{
    vanilla: { settled: number; future: number; spendable: number }
    colored: { settled: number; future: number; spendable: number }
  }> {
    this.assertConnected()
    const v: any = (await this.account.getBtcBalance()) ?? {}
    return {
      vanilla: readRgbLibBtcBalanceBucket(v.vanilla ?? v),
      colored: v.colored ? readRgbLibBtcBalanceBucket(v.colored) : { settled: 0, spendable: 0, future: 0 },
    }
  }

  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    const { vanilla, colored } = await this.detailedBtcBalance()
    const settled = vanilla.settled + colored.settled
    const spendable = vanilla.spendable + colored.spendable
    const future = vanilla.future + colored.future
    return { confirmed: settled, unconfirmed: Math.max(0, future - settled), total: spendable }
  }

  /** Detailed BTC balance with the vanilla / colored split (IProtocolAdapter hook). */
  async getRgbDetailedBalance(): Promise<{
    vanilla: { settled: number; future: number; spendable: number }
    colored: { settled: number; future: number; spendable: number }
  }> {
    return this.detailedBtcBalance()
  }

  async refreshBalances(): Promise<void> {
    this.assertConnected()
    try {
      // Sync the wallet ONCE, then refresh transfer statuses reusing that sync
      // (skip_sync=true). Previously refresh(skip_sync=false) synced and then we
      // synced again — two full indexer round-trips, ~2× the cold-sync wait.
      await this.account.sync(this.online)
      await this.account.refresh(this.online, null, [], true)
      // Durably commit the refreshed state. In MV3 the service worker is killed
      // aggressively; without a flush the settled-transfer promotion lives only
      // in memory and is lost on the next cold start, which re-surfaces as stale
      // balances / "insufficient assignments" on the following send.
      await this.flushState()
    } catch (e) {
      // best-effort, but surface the cause — a silent failure leaves the wallet
      // showing 0 balance / no history.
      console.error('[RGB-L1] refresh/sync failed:', e)
    }
  }

  async listAssets(): Promise<UnifiedAsset[]> {
    this.assertConnected()
    const { total } = await this.getBtcBalance()
    const out: UnifiedAsset[] = [rgbBtcAsset(total, RGB_L1_PROFILE)]
    const res: any = await this.account.listAssets([])
    const assets: any[] = Array.isArray(res) ? res : [...(res?.nia ?? []), ...(res?.ifa ?? [])]
    for (const a of assets) out.push(rgbNiaAsset(normalizeAsset(a), RGB_L1_PROFILE))
    return out
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    this.assertConnected()
    try {
      const raw: any = await this.account.getAssetBalance(assetId)
      return rgbAssetBalance(raw)
    } catch {
      const a = (await this.listAssets()).find((x) => x.id === assetId)
      return a?.balance ?? rgbAssetBalance({})
    }
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const found = (await this.listAssets()).find((a) => a.id === assetId)
    if (!found) throw new ProtocolError(`Unknown asset ${assetId}`, 'RGB_L1', 'NO_ASSET')
    return found
  }

  // --- Invoices -----------------------------------------------------------
  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    this.assertConnected()
    if (!request.asset || request.asset === 'BTC') {
      throw new ProtocolError('RGB-L1 has no Lightning invoices; use getReceiveAddress for BTC', 'RGB_L1', 'NOT_SUPPORTED')
    }
    const inv: any = await this.receiveRgb({
      assetId: request.asset,
      amount: request.assetAmount,
      durationSeconds: request.expirySeconds,
    })
    return {
      invoice: inv?.invoice ?? '',
      paymentHash: inv?.recipientId ?? inv?.recipient_id ?? '',
      amount: request.assetAmount,
      expiresAt: inv?.expirationTimestamp ? inv.expirationTimestamp * 1000 : Date.now() + (request.expirySeconds ?? 3600) * 1000,
      description: request.description,
    }
  }

  async decodeInvoice(_invoice: string): Promise<DecodedInvoice> {
    throw new ProtocolError('RGB-L1 adapter does not decode invoices', 'RGB_L1', 'NOT_SUPPORTED')
  }

  // --- Send (Lightning not supported) -------------------------------------
  async sendPayment(_request: PaymentRequest): Promise<PaymentResult> {
    throw new ProtocolError('RGB-L1 has no Lightning send; use sendAsset or sendBtcOnchain', 'RGB_L1', 'NOT_SUPPORTED')
  }

  async getPaymentStatus(_paymentHash: string): Promise<PaymentStatus> {
    throw new ProtocolError('RGB-L1 has no Lightning payment status', 'RGB_L1', 'NOT_SUPPORTED')
  }

  // --- Transactions -------------------------------------------------------
  async listTransactions(_filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    this.assertConnected()
    const raw: any = await this.account.listTransactions()
    const txs: any[] = Array.isArray(raw) ? raw : raw?.transactions ?? []
    return txs.map((t) => {
      const { received, sent, type } = normalizeRgbLibTransactionAmounts(t)
      const confTime = t.confirmationTime ?? t.confirmation_time
      const timestampSeconds = normalizeRgbLibTimestamp(confTime)
      return {
        id: t.txid ?? t.transactionId ?? t.transaction_id ?? '',
        type,
        status: (timestampSeconds ? 'confirmed' : 'pending') as TransactionStatus,
        timestamp: timestampSeconds * 1000,
        amount: Math.abs(received - sent) || received || sent,
        amountDisplay: '',
        asset: undefined as unknown as UnifiedAsset,
        protocolData: {
          ...t,
          transactionType: normalizeRgbLibTxType(t.transactionType ?? t.transaction_type),
        },
      }
    })
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    const found = (await this.listTransactions()).find((t) => t.id === txId)
    if (!found) throw new ProtocolError(`Unknown tx ${txId}`, 'RGB_L1', 'NO_TX')
    return found
  }

  async getNodeInfo(): Promise<NodeInfo> {
    return {}
  }

  async listChannels(): Promise<unknown[]> {
    return []
  }

  async listPayments(): Promise<unknown> {
    return []
  }

  async listTransfers(options?: { asset_id?: string }): Promise<unknown> {
    this.assertConnected()
    return this.account.listTransfers(options?.asset_id ?? null)
  }

  // --- RGB-specific hooks (used by the RGB host surface) ------------------
  async createRgbInvoice(params: {
    assetId?: string
    amount?: number
    durationSeconds?: number
    minConfirmations?: number
    /** false ⇒ blinded receive (private, default); true ⇒ witness receive. */
    witness?: boolean
    /** Host-supplied assignment, e.g. { type: 'Fungible', value: 100 }. */
    assignment?: { type?: string; value?: number } | null
  }): Promise<any> {
    this.assertConnected()
    return this.receiveRgb(params)
  }

  /**
   * Generate an RGB receive invoice. Defaults to a blinded receive (the
   * recipient UTXO is hidden); `witness: true` uses a witness receive (the
   * sender creates the UTXO). rgb-lib's `Assignment` enum is `{ Fungible: <num> }`
   * for a specific amount or the unit string `"Any"` — NOT null, and NOT bigint.
   */
  private async receiveRgb(opts: {
    assetId?: string | null
    amount?: number
    assignment?: { type?: string; value?: number } | null
    durationSeconds?: number | null
    minConfirmations?: number
    witness?: boolean
  }): Promise<any> {
    const fungibleValue =
      opts.amount != null
        ? opts.amount
        : opts.assignment?.type === 'Fungible' && opts.assignment.value != null
          ? opts.assignment.value
          : undefined
    const assignment = fungibleValue != null ? { Fungible: Number(fungibleValue) } : 'Any'
    const args = [
      opts.assetId ?? null,
      assignment,
      opts.durationSeconds ?? null,
      this.transportEndpoints,
      opts.minConfirmations ?? 1,
    ] as const
    const res: any = await (opts.witness
      ? this.account.witnessReceive(...args)
      : this.account.blindReceive(...args))
    // Generating an invoice records a pending transfer in the wallet DB; flush so
    // it survives a service-worker restart before the payer pays it.
    await this.flushState()
    // Normalize to a plain, structured-clone-safe object: the wasm result can
    // carry BigInt / wasm-bound values that break chrome message passing
    // ("could not serialize message"). Coerce the fields the host reads.
    return {
      invoice: res?.invoice ?? '',
      recipientId: res?.recipientId ?? res?.recipient_id ?? '',
      recipient_id: res?.recipientId ?? res?.recipient_id ?? '',
      expirationTimestamp:
        res?.expirationTimestamp != null ? Number(res.expirationTimestamp) : undefined,
      batchTransferIdx:
        res?.batchTransferIdx != null ? Number(res.batchTransferIdx) : undefined,
    }
  }

  async signPsbt(psbtHex: string): Promise<{ psbt: string; unchanged: boolean }> {
    this.assertConnected()
    const signed: string = await this.account.signPsbt(psbtHex)
    return { psbt: signed ?? psbtHex, unchanged: !signed || signed === psbtHex }
  }

  async createRgbUtxos(params: { num?: number; size?: number; feeRate?: number; upTo?: boolean }): Promise<{ success: boolean }> {
    this.assertConnected()
    // Same rationale as sendAsset: createUtxosBegin selects from vanilla UTXOs
    // tracked in the local DB; sync first so the indexer's current view is used.
    await this.refreshBalances()
    const feeRate = BigInt(Math.round(params.feeRate ?? 1))
    const unsigned: string = await this.account.createUtxosBegin(
      this.online,
      params.upTo ?? false,
      params.num ?? null,
      params.size ?? null,
      feeRate,
      false
    )
    const signed = await this.account.signPsbt(unsigned)
    await this.account.createUtxosEnd(this.online, signed, false)
    // Commit the new UTXO set before the caller relies on it (e.g. immediately
    // issuing/receiving against the freshly-created colorable UTXOs).
    await this.flushState()
    return { success: true }
  }

  async sendAsset(params: {
    assetId?: string
    token: string
    recipientId?: string
    recipient: string
    amount: number
    assignment?: { type?: string; value?: number } | null
    feeRate?: number
    minConfirmations?: number
    donation?: boolean
    /** Transport endpoints from the recipient's invoice; falls back to the sender's. */
    transportEndpoints?: string[]
    /** Set only for witness invoices (blinded otherwise). */
    witnessData?: { amountSat?: number; amount_sat?: number; blinding?: number } | null
    witness_data?: { amountSat?: number; amount_sat?: number; blinding?: number } | null
  }): Promise<any> {
    this.assertConnected()
    const token = params.token ?? params.assetId
    const recipientId = params.recipient ?? params.recipientId
    if (!token) throw new ProtocolError('RGB-L1 asset send requires an asset id', 'RGB_L1', 'INVALID_REQUEST')
    if (!recipientId) throw new ProtocolError('RGB-L1 asset send requires a recipient id', 'RGB_L1', 'INVALID_REQUEST')
    const amount = Number(params.amount ?? params.assignment?.value ?? 0)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ProtocolError('RGB-L1 asset send requires a positive amount', 'RGB_L1', 'INVALID_REQUEST')
    }
    const transportEndpoints =
      Array.isArray(params.transportEndpoints) && params.transportEndpoints.length > 0
        ? params.transportEndpoints
        : this.transportEndpoints
    const assignment = toRgbLibAssignment(params.assignment, amount)
    const recipient: Record<string, unknown> = {
      // rgb-lib-wasm examples use camelCase, while the desktop rgb-lib client
      // path sends snake_case. Keep both so this adapter survives either wasm
      // serde casing without changing the host API.
      recipientId,
      recipient_id: recipientId,
      assignment,
      transportEndpoints,
      transport_endpoints: transportEndpoints,
    }
    const wd = params.witnessData ?? params.witness_data
    if (wd) {
      const amountSat = wd.amountSat ?? wd.amount_sat
      const witnessData = {
        amountSat: Math.round(Number(amountSat ?? 0)),
        amount_sat: Math.round(Number(amountSat ?? 0)),
        ...(wd.blinding != null ? { blinding: Math.round(Number(wd.blinding)) } : {}),
      }
      recipient.witnessData = witnessData
      recipient.witness_data = witnessData
    }
    const recipientMap = {
      [token]: [recipient],
    }
    // rgb-lib's `send` only spends *settled* allocations it knows about locally.
    // Without a fresh sync+refresh right before sendBegin, a received transfer
    // that hasn't been promoted to Settled in the local DB (e.g. after a SW
    // restart or IndexedDB restore) is invisible to the spend, and sendBegin
    // fails with "Insufficient total assignments" despite a non-zero UI balance.
    await this.refreshBalances()
    const feeRate = BigInt(Math.round(params.feeRate ?? 1))
    const unsigned: string = await this.account.sendBegin(
      this.online,
      recipientMap,
      params.donation ?? false,
      feeRate,
      params.minConfirmations ?? 1
    )
    const signed = await this.account.signPsbt(unsigned)
    const result = await this.account.sendEnd(this.online, signed, false)
    // The spend is broadcast; persist the consumed-allocation state so a SW kill
    // can't leave the wallet thinking the inputs are still spendable (which would
    // later fail as "insufficient assignments" or attempt a double-spend).
    await this.flushState()
    return result
  }

  async sendBtcOnchain(params: { address: string; amount: number; feeRate?: number }): Promise<any> {
    this.assertConnected()
    const feeRate = BigInt(Math.round(params.feeRate ?? 1))
    const unsigned: string = await this.account.sendBtcBegin(
      this.online,
      params.address,
      BigInt(params.amount),
      feeRate,
      false
    )
    const signed = await this.account.signPsbt(unsigned)
    const txid: string = await this.account.sendBtcEnd(this.online, signed, false)
    await this.flushState()
    return { ok: true, txid }
  }

  // --- UTXOs / fees / metadata / transfer maintenance ---------------------
  /**
   * List the wallet's unspent outputs and their RGB allocations
   * (IProtocolAdapter hook). Normalizes rgb-lib's camel/snake casing and the
   * `Outpoint` (object `{txid,vout}` or `"txid:vout"` string) into the flat shape
   * the host consumes.
   */
  async listRgbUnspents(): Promise<{
    unspents: Array<{
      utxo: { outpoint: string; btc_amount: number; colorable: boolean }
      rgb_allocations: Array<{ asset_id?: string | null; assignment: unknown; settled: boolean }>
    }>
  }> {
    this.assertConnected()
    const raw: any = await this.account.listUnspents(false)
    const list: any[] = Array.isArray(raw) ? raw : raw?.unspents ?? []
    return {
      unspents: list.map((u) => {
        const utxo = u?.utxo ?? u ?? {}
        const allocations: any[] = u?.rgbAllocations ?? u?.rgb_allocations ?? []
        return {
          utxo: {
            outpoint: formatOutpoint(utxo.outpoint),
            btc_amount: toFiniteNumber(utxo.btcAmount ?? utxo.btc_amount ?? 0),
            colorable: Boolean(utxo.colorable),
          },
          rgb_allocations: allocations.map((a) => ({
            asset_id: a?.assetId ?? a?.asset_id ?? null,
            assignment: a?.assignment ?? null,
            settled: Boolean(a?.settled),
          })),
        }
      }),
    }
  }

  /** Estimate the on-chain fee rate (sat/vB) for a confirmation target (IProtocolAdapter hook). */
  async estimateRgbFee(blocks: number): Promise<{ fee_rate: number }> {
    this.assertConnected()
    const target = Number.isFinite(blocks) && blocks > 0 ? Math.round(blocks) : 6
    const rate = await this.account.getFeeEstimation(this.online, target)
    return { fee_rate: toFiniteNumber(rate) }
  }

  /** Asset metadata (name, ticker, precision, supply). */
  async getAssetMetadata(assetId: string): Promise<Record<string, unknown>> {
    this.assertConnected()
    const meta: any = await this.account.getAssetMetadata(assetId)
    return {
      asset_id: assetId,
      asset_schema: meta?.assetSchema ?? meta?.asset_schema,
      name: meta?.name,
      ticker: meta?.ticker,
      precision: meta?.precision,
      initial_supply: toFiniteNumber(meta?.initialSupply ?? meta?.initial_supply ?? 0),
      max_supply: meta?.maxSupply ?? meta?.max_supply,
      known_circulating_supply: meta?.knownCirculatingSupply ?? meta?.known_circulating_supply,
      timestamp: meta?.timestamp,
    }
  }

  /**
   * Status of a received invoice: matches the pending transfer by recipient id /
   * invoice string and returns its rgb-lib status (WaitingCounterparty,
   * WaitingConfirmations, Settled, Failed, …).
   */
  async getInvoiceStatus(params: { invoice: string }): Promise<unknown> {
    this.assertConnected()
    const needle = String(params.invoice ?? '')
    const raw: any = await this.account.listTransfers(null)
    const transfers: any[] = Array.isArray(raw) ? raw : raw?.transfers ?? []
    const match = transfers.find((t) => {
      const fields = [t?.recipientId, t?.recipient_id, t?.invoiceString, t?.invoice_string, t?.invoice]
      return fields.some((f) => f && String(f) === needle)
    })
    return { status: match?.status ?? null, transfer: match ?? null }
  }

  /**
   * Fail expired/stuck pending transfers (default: all). Stuck WaitingCounterparty
   * transfers hold allocations and can block a later spend with "insufficient
   * assignments"; failing then deleting them frees those allocations.
   */
  async failRgbTransfers(
    params: { batchTransferIdx?: number | null; noAssetOnly?: boolean } = {},
  ): Promise<{ changed: boolean }> {
    this.assertConnected()
    const changed: boolean = await this.account.failTransfers(
      this.online,
      params.batchTransferIdx ?? null,
      params.noAssetOnly ?? false,
      false,
    )
    await this.flushState()
    return { changed: Boolean(changed) }
  }

  /** Delete already-failed transfers from the wallet DB. */
  async deleteRgbTransfers(
    params: { batchTransferIdx?: number | null; noAssetOnly?: boolean } = {},
  ): Promise<{ changed: boolean }> {
    this.assertConnected()
    const changed: boolean = await this.account.deleteTransfers(
      params.batchTransferIdx ?? null,
      params.noAssetOnly ?? false,
    )
    await this.flushState()
    return { changed: Boolean(changed) }
  }

  /**
   * Durably commit wallet state to IndexedDB. Best-effort and version-guarded:
   * `flush()` was added after `@utexo/rgb-lib-wasm@1.0.0-beta.2`, so on older
   * builds this is a no-op (the wasm persists opportunistically). A failed flush
   * leaves in-memory state intact and is safe to retry, so we log and continue.
   */
  private async flushState(): Promise<void> {
    const fn = (this.account as { flush?: unknown } | null)?.flush
    if (typeof fn !== 'function') return
    try {
      await (this.account as { flush: () => Promise<void> }).flush()
    } catch (e) {
      console.error('[RGB-L1] flush failed:', e)
    }
  }

  // ==========================================================================
  // Backup / VSS
  //
  // RGB state (allocations/consignments) can't be rebuilt from the seed, so it
  // must be backed up after every settled transfer. rgb-lib encrypts the blob
  // client-side before it ever leaves the wallet, so the VSS server only stores
  // ciphertext. All calls route through the serialized account queue, so a
  // backup can't interleave with a concurrent wallet mutation.
  // ==========================================================================

  /** Encrypted wallet backup bytes (rgb-lib's own format). */
  async backup(password: string): Promise<Uint8Array> {
    this.assertConnected()
    return this.account.backup(password)
  }

  /** Restore wallet state from encrypted backup bytes produced by {@link backup}. */
  async restoreBackup(params: { backupBytes: Uint8Array; password: string }): Promise<void> {
    this.assertConnected()
    await this.account.restoreBackup(params.backupBytes, params.password)
    await this.flushState()
  }

  /** Whether local wallet state has changed since the last backup. */
  async backupInfo(): Promise<{ required: boolean }> {
    this.assertConnected()
    return { required: Boolean(await this.account.backupInfo()) }
  }

  /** Configure VSS (cloud) backup: server URL, per-wallet store id, signing key (hex). */
  async configureVssBackup(params: {
    serverUrl: string
    storeId: string
    signingKeyHex: string
  }): Promise<void> {
    this.assertConnected()
    await this.account.configureVssBackup(params.serverUrl, params.storeId, params.signingKeyHex)
  }

  /** Disable VSS (cloud) backup for this wallet. */
  async disableVssBackup(): Promise<void> {
    this.assertConnected()
    await this.account.disableVssBackup()
  }

  /** Upload an encrypted backup to the configured VSS server. Returns the new server version. */
  async vssBackup(): Promise<{ serverVersion: number | null }> {
    this.assertConnected()
    // rgb-lib returns the raw server version (may be a BigInt) — normalize so it
    // survives structured-clone across the extension's SW message boundary.
    const raw = await this.account.vssBackup()
    return { serverVersion: raw != null ? toFiniteNumber(raw) : null }
  }

  /** VSS backup status: { backup_exists, server_version, backup_required } → camelCase, no BigInt. */
  async vssBackupInfo(): Promise<{
    backupExists: boolean
    serverVersion: number | null
    backupRequired: boolean
  }> {
    this.assertConnected()
    const raw = (await this.account.vssBackupInfo()) as Record<string, unknown> | null
    return {
      backupExists: Boolean(raw?.backup_exists),
      serverVersion: raw?.server_version != null ? toFiniteNumber(raw.server_version) : null,
      backupRequired: Boolean(raw?.backup_required),
    }
  }

  /** Download and restore wallet state from the configured VSS server. */
  async vssRestoreBackup(): Promise<void> {
    this.assertConnected()
    await this.account.vssRestoreBackup()
    await this.flushState()
  }

  override async disconnect(): Promise<void> {
    this.online = null
    await super.disconnect()
  }
}

function normalizeRgbLibTimestamp(confTime: unknown): number {
  if (typeof confTime === 'number' || typeof confTime === 'string' || typeof confTime === 'bigint') {
    return toFiniteNumber(confTime)
  }
  if (confTime && typeof confTime === 'object') {
    const obj = confTime as Record<string, unknown>
    return firstFiniteNumber(obj.timestamp, obj.blockTime, obj.block_time, obj.time) ?? 0
  }
  return 0
}

/** rgb-lib serializes an Outpoint as `{txid,vout}` or the `"txid:vout"` string. */
function formatOutpoint(outpoint: unknown): string {
  if (typeof outpoint === 'string') return outpoint
  if (outpoint && typeof outpoint === 'object') {
    const o = outpoint as Record<string, unknown>
    const txid = o.txid ?? o.txId
    const vout = o.vout ?? o.index
    if (txid != null && vout != null) return `${txid}:${vout}`
  }
  return ''
}

function toRgbLibAssignment(
  assignment: { type?: string; value?: number } | null | undefined,
  amount: number,
): { Fungible: number } {
  if (assignment?.type && assignment.type !== 'Fungible') {
    throw new ProtocolError(`Unsupported RGB-L1 assignment type: ${assignment.type}`, 'RGB_L1', 'INVALID_REQUEST')
  }
  return { Fungible: Math.round(amount) }
}

function readRgbLibBtcBalanceBucket(bucket: any): { settled: number; spendable: number; future: number } {
  const settled = toFiniteNumber(bucket?.settled ?? bucket?.confirmed ?? bucket?.total ?? 0)
  const spendable = toFiniteNumber(bucket?.spendable ?? bucket?.available ?? settled)
  const future = toFiniteNumber(bucket?.future ?? bucket?.unconfirmed ?? spendable)
  return { settled, spendable, future }
}

/** Map rgb-lib's `TransactionType` to a stable string; unknowns ⇒ "User". */
function normalizeRgbLibTxType(raw: unknown): 'User' | 'RgbSend' | 'CreateUtxos' {
  const v = String(raw ?? '')
  if (v === 'RgbSend' || v === 'CreateUtxos') return v
  return 'User'
}

function normalizeRgbLibTransactionAmounts(t: any): {
  received: number
  sent: number
  type: Extract<UnifiedTransaction['type'], 'send' | 'receive'>
} {
  const explicitReceived = firstFiniteNumber(
    t.received,
    t.receivedSat,
    t.received_sat,
    t.incoming,
    t.incomingSat,
    t.incoming_sat,
  )
  const explicitSent = firstFiniteNumber(
    t.sent,
    t.sentSat,
    t.sent_sat,
    t.outgoing,
    t.outgoingSat,
    t.outgoing_sat,
  )
  if (explicitReceived !== null || explicitSent !== null) {
    const received = explicitReceived ?? 0
    const sent = explicitSent ?? 0
    return { received, sent, type: received >= sent ? 'receive' : 'send' }
  }

  const rawDirection = String(t.type ?? t.direction ?? t.transactionDirection ?? '').toLowerCase()
  const signedAmount = firstFiniteNumber(t.amount, t.amountSat, t.amount_sat, t.value, t.valueSat)
  const amount = Math.abs(signedAmount ?? 0)
  if (rawDirection.includes('send') || rawDirection.includes('out') || (signedAmount ?? 0) < 0) {
    return { received: 0, sent: amount, type: 'send' }
  }
  return { received: amount, sent: 0, type: 'receive' }
}

/**
 * Normalize an rgb-lib-wasm asset record into the shape `RgbCore.rgbNiaAsset`
 * expects (it may use camelCase `assetId` or snake_case `asset_id`).
 */
function normalizeAsset(a: any): {
  asset_id: string
  name?: string
  ticker?: string
  precision?: number | string
  balance?: RgbBalanceLike
} {
  return {
    asset_id: a?.assetId ?? a?.asset_id ?? a?.id ?? '',
    name: a?.name,
    ticker: a?.ticker,
    precision: a?.precision,
    balance: normalizeAssetBalance(a?.balance ?? a),
  }
}

function normalizeAssetBalance(a: any): RgbBalanceLike | undefined {
  if (!a) return undefined
  return {
    settled: a.settled ?? a.total,
    future: a.future ?? a.pending,
    spendable: a.spendable ?? a.available,
    offchain_outbound: a.offchain_outbound ?? a.offchainOutbound ?? a.locked,
    offchain_inbound: a.offchain_inbound ?? a.offchainInbound,
  }
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const n = typeof value === 'bigint' ? Number(value) : Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}
