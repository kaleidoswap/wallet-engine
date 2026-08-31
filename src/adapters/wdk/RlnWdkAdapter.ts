/**
 * RlnWdkAdapter
 * -------------
 * Wraps the WDK RGB-Lightning module (@kaleidorg/wdk-wallet-rln, over kaleido-sdk)
 * onto the `IProtocolAdapter` contract: BTC on-chain and Lightning, RGB assets
 * on-chain and over Lightning, plus channels and atomic swaps. The RLN account
 * talks to a remote RGB-Lightning node over HTTP (nodeUrl).
 *
 * No WDK/kaleido-sdk types cross the contract — node responses are read as `any`
 * and translated.
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
  QuoteRequest,
  Quote,
  SwapResult,
  ProtocolError,
} from '../../types/base'
import { getCapabilities } from '../../capabilities'
import { PROTOCOL_OPERATIONS } from '../../capabilities/operations'
import { loadWdkModule } from './moduleLoader'
import { isBolt11 } from '../../lib/bolt11'
import { assertSafeToSign } from '../../lib/ln-message-sign'
import { mapRgbStatus, rgbBtcAsset, rgbNiaAsset, rgbAssetBalance, RLN_PROFILE } from './RgbCore'
import { BaseWdkAdapter } from './BaseWdkAdapter'
import { KaleidoswapSwap, type SwapQuoteRequest } from '../../swap/KaleidoswapSwap'
import { resolveWalletSeed } from '../../lib/wallet-seed'
import { decodeBolt11 } from '../../lib/bolt11'
import { MAINNET_FEE_FLOOR } from '../../lib/rgb-fee-policy'
import { applyTransactionFilter } from '../../lib/transaction-filter'

export interface RlnAdapterConfig extends BaseProtocolConfig {
  protocol: 'RGB_LN'
  /** BIP-39 mnemonic for this wallet. */
  mnemonic: string
  /** Base URL of the RLN HTTP API (e.g. http://localhost:3001). */
  nodeUrl: string
  /** KaleidoSwap maker API base URL (for cross-asset RFQ swaps). */
  makerUrl?: string
  /** BIP-44 account index (default 0). */
  accountIndex?: number
  /**
   * Bearer token for a multi-tenant RLN node — required whenever `nodeUrl` is
   * shared across tenants. `jwt` is accepted as an alias.
   */
  apiKey?: string
  jwt?: string
  /**
   * Opt-in gate for fund-moving node ops on `executeProtocolOperation`. Off by
   * default because `operation` may be caller-influenced (deep links, chat/MCP
   * args) and these ops move funds with no policy gate or confirmation hook.
   */
  allowPrivilegedOps?: boolean
}

/**
 * Allowlist of RLN account methods reachable via `executeProtocolOperation` —
 * RLN-specific ops not already typed adapter methods. Anything unlisted is
 * rejected; see the method's SECURITY note.
 */
const RLN_ALLOWED_OPS: ReadonlySet<string> = new Set([
  'getChannelId',
  'connectPeer',
  'disconnectPeer',
  'listPeers',
  'listUnspents',
  'estimateFee',
  'failTransfers',
  'syncRgbWallet',
  'getAssetMetadata',
  'getAssetMedia',
  'getTakerPubkey',
  'listSwaps',
  'getSwap',
  'signMessage',
  // 'restore' / 'changePassword' are deliberately NOT allowlisted: they are
  // wallet-lifecycle ops and `operation` may be caller-influenced. Hosts needing
  // them must call the account directly behind their own gating UI.
])

/**
 * Fund-moving / custody-relevant node ops, reachable only when the host opts in
 * via `allowPrivilegedOps`. Each can move funds (or, for backup, exfiltrate
 * wallet state) with no policy gate, so they must never be reachable from an
 * attacker-influenced `operation` string by default.
 */
const RLN_PRIVILEGED_OPS: ReadonlySet<string> = new Set([
  'openChannel',
  'closeChannel',
  'keysend',
  'createUtxos',
  'whitelistSwap',
  'atomicTaker',
  'makerInit',
  'makerExecute',
  'backup',
])

export class RlnWdkAdapter extends BaseWdkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'RGB_LN'
  readonly capabilities = PROTOCOL_OPERATIONS.RGB_LN
  readonly supportedLayers: Layer[] = getCapabilities('RGB_LN').layers

  /** KaleidoSwap maker base URL, for cross-asset RFQ swaps (Option C: swaps live in the adapter). */
  private makerUrl = ''

  /**
   * RLN swaps need a maker. `BaseWdkAdapter.supportsSwaps()` returns the STATIC
   * capability-manifest flag, so this adapter answered `true` on a config with no
   * `makerUrl` while both swap entry points throw CONFIG
   * ("RLN swaps require a makerUrl in the adapter config", :587-589) — and
   * `ProtocolManager.getSwapQuote`/`executeSwap` gate on exactly this method
   * before calling through. The native `RgbAdapter` sibling is config-dependent;
   * this is that parity.
   */
  supportsSwaps(): boolean {
    return super.supportsSwaps() && !!this.makerUrl
  }
  /** Lazily-built maker swap client, bound to this connected account. */
  private swap: KaleidoswapSwap | null = null
  /** Host opt-in for fund-moving escape-hatch ops (see RLN_PRIVILEGED_OPS). */
  private allowPrivilegedOps = false

  // --- Connection ---------------------------------------------------------
  async connect(config: BaseProtocolConfig): Promise<void> {
    const cfg = config as RlnAdapterConfig
    if (!cfg.mnemonic) throw new ProtocolError('RlnWdkAdapter requires a mnemonic', 'RGB_LN', 'CONFIG')
    if (!cfg.nodeUrl) throw new ProtocolError('RlnWdkAdapter requires a nodeUrl', 'RGB_LN', 'CONFIG')
    await this.releasePreviousConnection()
    this.network = cfg.network ?? 'mainnet'
    this.makerUrl = cfg.makerUrl ?? ''
    this.swap = null
    this.allowPrivilegedOps = cfg.allowPrivilegedOps === true
    // @ts-ignore — declared as a workspace/optional dep; resolved at runtime.
    const mod = await loadWdkModule('@kaleidorg/wdk-wallet-rln', () => import('@kaleidorg/wdk-wallet-rln'))
    const RlnWalletManager = mod.default ?? mod
    // Resolve to seed bytes so nsec/hex-rooted wallets bypass the WDK base's
    // BIP-39 string validation (which throws "The seed phrase is invalid").
    this.manager = new RlnWalletManager(resolveWalletSeed(cfg.mnemonic), {
      nodeUrl: cfg.nodeUrl,
      apiKey: cfg.jwt ?? cfg.apiKey,
    })
    this.account = await this.manager.getAccount(cfg.accountIndex ?? 0)
    this.connected = true
  }

  async disconnect(): Promise<void> {
    try {
      await super.disconnect()
    } finally {
      // Base clears manager/account/mnemonic; this adapter also holds a
      // maker-bound swap client and its URL, which must not outlive disconnect.
      this.swap = null
      this.makerUrl = ''
      this.allowPrivilegedOps = false
    }
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    this.assertConnected()
    const info: any = await this.account.getNodeInfo()
    return {
      protocol: 'RGB_LN',
      connected: this.connected,
      nodeId: info?.pubkey,
      network: this.network,
    }
  }

  // --- Address / receive --------------------------------------------------
  async getReceiveAddress(assetId?: string): Promise<Address> {
    this.assertConnected()
    if (assetId && assetId.toLowerCase() !== 'btc') {
      const inv: any = await this.createRgbInvoice({ assetId })
      return { address: inv?.invoice ?? '', format: 'RGB_INVOICE', asset: assetId }
    }
    const address: string = await this.account.getAddress()
    return { address, format: 'BTC_ADDRESS' }
  }

  // --- Balance ------------------------------------------------------------
  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    this.assertConnected()
    const b: any = await this.account.getBtcBalance()
    const v = b?.vanilla ?? {}
    const settled = Number(v.settled ?? 0)
    const spendable = Number(v.spendable ?? settled)
    return { confirmed: settled, unconfirmed: Math.max(0, Number(v.future ?? spendable) - settled), total: spendable }
  }

  async refreshBalances(): Promise<void> {
    this.assertConnected()
    await this.account.refreshTransfers?.({ skipSync: false }).catch(() => {})
  }

  async listAssets(): Promise<UnifiedAsset[]> {
    this.assertConnected()
    const { total } = await this.getBtcBalance()
    const out: UnifiedAsset[] = [rgbBtcAsset(total, RLN_PROFILE)]

    // Fungible RGB schemas: NIA (USDT/XAUT) + IFA. rgbNiaAsset is a generic
    // fungible mapper so it covers both. Older nodes' rgb-lib rejects IFA as a
    // filter value, so fall back to NIA only.
    let res: any
    try {
      res = await this.account.listAssets(['Nia', 'Ifa'])
    } catch {
      res = await this.account.listAssets(['Nia'])
    }
    const fungibles: any[] = [...(res?.nia ?? []), ...(res?.ifa ?? [])]
    for (const a of fungibles) out.push(rgbNiaAsset(a, RLN_PROFILE))
    return out
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    this.assertConnected()
    const b: any = await this.account.getAssetBalance(assetId)
    const precision = (await this.listAssets()).find((a) => a.id === assetId)?.precision ?? 0
    return rgbAssetBalance(b, precision)
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets()
    const found = assets.find((a) => a.id === assetId)
    if (!found) throw new ProtocolError(`Unknown asset ${assetId}`, 'RGB_LN', 'NO_ASSET')
    return found
  }

  // --- Invoices -----------------------------------------------------------
  private get node(): any {
    const raw = (this.account as any)?._rln
    if (!raw) throw new ProtocolError('RLN node client unavailable', 'RGB_LN', 'NOT_CONNECTED')
    return raw
  }

  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    this.assertConnected()
    const isAsset = !!request.asset && request.asset !== 'BTC'
    const wantsOnchain = request.layer === 'RGB_L1' || request.layer === 'BTC_L1'

    if (isAsset && !wantsOnchain) {
      const inv: any = await this.node.createLNInvoice({
        amt_msat: request.amount != null ? request.amount * 1000 : 3_000_000,
        expiry_sec: request.expirySeconds ?? 3600,
        asset_id: request.asset,
        ...(request.assetAmount != null ? { asset_amount: request.assetAmount } : {}),
      })
      return {
        invoice: inv?.invoice ?? '',
        paymentHash: inv?.payment_hash ?? '',
        amount: request.assetAmount,
        expiresAt: Date.now() + (request.expirySeconds ?? 3600) * 1000,
        description: request.description,
      }
    }

    if (isAsset) {
      const inv: any = await this.createRgbInvoice({
        assetId: request.asset,
        amount: request.assetAmount,
        durationSeconds: request.expirySeconds,
      })
      return {
        invoice: inv?.invoice ?? '',
        paymentHash: inv?.recipient_id ?? '',
        amount: request.assetAmount,
        expiresAt: inv?.expiration_timestamp
          ? inv.expiration_timestamp * 1000
          : Date.now() + (request.expirySeconds ?? 3600) * 1000,
        description: request.description,
      }
    }

    const inv: any = await this.node.createLNInvoice({
      amt_msat: request.amount != null ? request.amount * 1000 : undefined,
      expiry_sec: request.expirySeconds ?? 3600,
    })
    return {
      invoice: inv?.invoice ?? '',
      paymentHash: inv?.payment_hash ?? '',
      amount: request.amount,
      expiresAt: Date.now() + (request.expirySeconds ?? 3600) * 1000,
      description: request.description,
    }
  }

  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    this.assertConnected()
    const d: any = isBolt11(invoice)
      ? await this.account.decodeLNInvoice(invoice)
      : await this.account.decodeRgbInvoice(invoice)
    // An RGB on-chain invoice carries its requested amount in `assignment`
    // (`DecodeRGBInvoiceResponse.assignment`, kaleido-sdk node-types.d.ts:2911-2927
    // → `AssignmentFungible { type: 'Fungible', value }`). None of the other
    // fields read below — `amt_msat`, `amount`, `asset_amount`, `payment_hash`,
    // `payee_pubkey`, `expiry_sec` — exist on that response at all; they belong to
    // `DecodeLNInvoiceResponse`. So without reading `assignment` an amount-bearing
    // RGB invoice decoded to `asset_amount: undefined` and the confirmation screen
    // had no amount to show: the user paid blind.
    const assignment = d?.assignment as { type?: string; value?: unknown } | undefined
    const assignedAmount =
      assignment && typeof assignment === 'object' && assignment.type === 'Fungible'
        ? Number(assignment.value)
        : undefined
    return {
      paymentHash: d?.payment_hash ?? d?.recipient_id ?? '',
      // Sats-denominated: never stuff RGB asset units in here.
      amount: d?.amt_msat != null ? Math.floor(d.amt_msat / 1000) : d?.amount,
      amountMsat: d?.amt_msat,
      description: d?.description,
      // `expiry_sec` is a DURATION from the invoice's own `timestamp` (creation,
      // unix seconds — both on `DecodeLNInvoiceResponse`, node-types.d.ts:2888-2906).
      // Computing `Date.now() + expiry_sec` ignored `timestamp`, so an invoice
      // created 2h ago with a 1h expiry decoded as expiring in ANOTHER hour: a dead
      // invoice read as live to any caller gating a payment or refund on `expiresAt`.
      expiresAt: d?.expiry_sec
        ? (d?.timestamp != null
            ? (Number(d.timestamp) + Number(d.expiry_sec)) * 1000
            : Date.now() + d.expiry_sec * 1000)
        : (d?.expiration_timestamp ?? 0) * 1000,
      destination: d?.payee_pubkey ?? d?.recipient_id ?? '',
      asset_id: d?.asset_id,
      asset_amount:
        d?.asset_amount ?? (Number.isFinite(assignedAmount) ? assignedAmount : undefined),
    }
  }

  // --- Send ---------------------------------------------------------------
  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    this.assertConnected()
    const req = request as PaymentRequest & {
      asset_id?: string
      asset_amount?: number
    }
    const invoice = request.invoice.trim()
    const decoded = decodeBolt11(invoice)
    const body: any = { invoice }
    // Forward `amt_msat` only for amountless invoices — forwarding it for an
    // amount-bearing invoice silently re-amounts the payment to whatever the
    // caller passed (stale UI state, WebLN args) instead of the invoice amount.
    if (request.amount != null && request.amount > 0 && decoded.amountMsat == null) {
      body.amt_msat = request.amount * 1000
    }
    if (req.asset_id) body.asset_id = req.asset_id
    if (req.asset_amount != null) body.asset_amount = req.asset_amount
    const r: any = await this.node.sendPayment(body)
    return {
      paymentHash: r?.payment_hash ?? '',
      preimage: r?.payment_secret,
      // The node's `SendPaymentResponse` carries no amount and no fee
      // (kaleido-sdk node-types.d.ts:3568-3576), and `PaymentResult.amount` is a
      // REQUIRED field. Falling back to `request.amount ?? 0` recorded a 0-sat
      // send for every amount-bearing invoice — which is the correct call pattern
      // here, since the adapter deliberately does not re-amount those. Read the
      // amount the invoice actually encodes; `decodeBolt11` is already in scope.
      amount: Number(request.amount ?? decoded.amountSat ?? 0),
      // Still 0: nothing in the response reports the routing fee. A status
      // lookup is the only source, so callers must not read this as "free".
      fee: 0,
      status: mapRgbStatus(r?.status),
      timestamp: Date.now(),
    }
  }

  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    this.assertConnected()
    // An RLN node exposes invoice-status only for INBOUND invoices (keyed by
    // bolt11); an OUTBOUND payment's status lives in list_payments, keyed by
    // payment_hash. getInvoiceStatus({ paymentHash }) never resolves for a sent
    // payment, so a withdraw poll would time out after it settled.
    try {
      const r: any = await this.account.listPayments()
      const list: any[] = (r && r.payments) ?? (Array.isArray(r) ? r : [])
      const p = list.find((x) => (x?.payment_hash ?? x?.paymentHash) === paymentHash)
      if (p) return { paymentHash, status: mapRgbStatus(p?.status), error: p?.error }
    } catch {
      /* fall through — treat as still pending */
    }
    return { paymentHash, status: 'pending' }
  }

  // --- Transactions / payments -------------------------------------------
  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    this.assertConnected()
    const r: any = await this.account.listTransactions()
    const txs: any[] = r?.transactions ?? []
    // Direction and amount come from received/sent, not from a transaction_type
    // string: the node's enum is RgbSend | Drain | CreateUtxos | SendBtc |
    // Incoming — there is no 'User' — and the schema has no `amount` field. The
    // old predicate (`transaction_type === 'User' || t.amount < 0`) was therefore
    // always false, so EVERY on-chain tx reported as a receive; and `received ??
    // sent` always took `received`, which is 0 on a send. A full-wallet drain
    // displayed in history as "received 0". Matches the sibling adapters
    // (RgbLibWdkAdapter.ts:214, RgbLibWasmAdapter.ts:851-885).
    const mapped = txs.map((t) => {
      const received = Number(t.received ?? 0)
      const sent = Number(t.sent ?? 0)
      return {
        id: t.txid ?? t.transaction_id ?? '',
        type: (received >= sent ? 'receive' : 'send') as UnifiedTransaction['type'],
        status: (t.confirmation_time ? 'confirmed' : 'pending') as TransactionStatus,
        timestamp: (t.confirmation_time?.timestamp ?? 0) * 1000,
        amount: Math.abs(received - sent) || received || sent,
        amountDisplay: '',
        asset: undefined as unknown as UnifiedAsset,
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
    if (!found) throw new ProtocolError(`Unknown tx ${txId}`, 'RGB_LN', 'NO_TX')
    return found
  }

  async getNodeInfo(): Promise<any> {
    this.assertConnected()
    return this.account.getNodeInfo()
  }

  async listChannels(): Promise<any[]> {
    this.assertConnected()
    const r: any = await this.account.listChannels()
    return r?.channels ?? []
  }

  async listPayments(): Promise<any> {
    this.assertConnected()
    return this.account.listPayments()
  }

  async listTransfers(options?: { asset_id?: string }): Promise<any> {
    this.assertConnected()
    if (!options?.asset_id) return { transfers: [] }
    return this.account.listTransfers(options.asset_id)
  }

  // --- Optional protocol-specific hooks -----------------------------------
  async createRgbInvoice(params: any): Promise<any> {
    this.assertConnected()
    const assetId = params?.assetId ?? params?.asset_id
    const durationSeconds = params?.durationSeconds ?? params?.duration_seconds ?? 86400
    const assignment =
      params?.assignment ??
      (params?.amount != null ? { type: 'Fungible', value: params.amount } : undefined)
    const body: any = {
      ...(assetId ? { asset_id: assetId } : {}),
      expiration_timestamp: Math.floor(Date.now() / 1000) + durationSeconds,
      min_confirmations: params?.minConfirmations ?? params?.min_confirmations ?? 1,
      witness: params?.witness ?? true,
      ...(assignment ? { assignment } : {}),
    }
    return this.node.createRgbInvoice(body)
  }

  async decodeRgbInvoice(params: any): Promise<any> {
    this.assertConnected()
    return this.account.decodeRgbInvoice(params?.invoice ?? params)
  }

  async getInvoiceStatus(params: { invoice: string }): Promise<any> {
    this.assertConnected()
    return this.node.getInvoiceStatus({ invoice: params.invoice })
  }

  async sendAsset(params: any): Promise<any> {
    this.assertConnected()
    if (params?.recipientMap) return this.account.sendRgb(params)

    const assetId = params.assetId ?? params.asset_id
    const recipientId = params.recipientId ?? params.recipient_id
    const transportEndpoints = params.transportEndpoints ?? params.transport_endpoints ?? []
    const witnessData = params.witnessData ?? params.witness_data
    const amount = params.amount ?? params.assignment?.value
    const assignment =
      params.assignment ?? (amount != null ? { type: 'Fungible', value: amount } : undefined)

    return this.account.sendRgb({
      recipientMap: {
        [assetId]: [
          {
            recipient_id: recipientId,
            assignment,
            transport_endpoints: transportEndpoints,
            ...(witnessData ? { witness_data: witnessData } : {}),
          },
        ],
      },
      feeRate: params.feeRate ?? params.fee_rate ?? this.defaultFeeRate(),
      donation: params.donation ?? false,
      minConfirmations: params.minConfirmations ?? params.min_confirmations ?? 1,
    })
  }

  async sendBtcOnchain(params: { address: string; amount: number; feeRate?: number }): Promise<any> {
    this.assertConnected()
    const r: any = await this.account.sendBtc(params)
    const txid: string = r?.txid ?? ''
    // A send that reports success with no transaction id can never be tracked or
    // reconciled, and a status poll on `''` returns pending forever. The in-repo
    // precedent is `ArkadeWdkAdapter.sendBtcOnchain`, which throws
    // SEND_ERROR here; docs/wdk-parity.md:68-70 calls it "never silent success".
    if (!txid) {
      throw new ProtocolError('BTC send did not return a transaction ID', 'RGB_LN', 'SEND_ERROR')
    }
    return { ok: true, txid }
  }

  // --- RGB on-chain UTXO management ----------------------------------------
  async listRgbUnspents(): Promise<{
    unspents: Array<{
      utxo: { outpoint: string; btc_amount: number; colorable: boolean }
      rgb_allocations: Array<{ asset_id?: string | null; assignment: unknown; settled: boolean }>
    }>
  }> {
    this.assertConnected()
    const res: any = await this.account.listUnspents()
    return { unspents: res?.unspents ?? [] }
  }

  async createRgbUtxos(
    params: { num?: number; size?: number; feeRate?: number; upTo?: boolean } = {},
  ): Promise<{ success: boolean }> {
    this.assertConnected()
    await this.account.createUtxos({
      up_to: params.upTo ?? false,
      num: params.num ?? 3,
      size: params.size ?? 3000,
      // Floor a cold-started node's 1 sat/vB estimate on mainnet — the estimate
      // is the node's opinion, not a policy, and this adapter never consulted
      // `resolveRgbFeeRatePolicy`.
      fee_rate: params.feeRate ?? Math.max((await this.estimateRgbFee(6)).fee_rate, this.defaultFeeRate()),
      skip_sync: false,
    })
    return { success: true }
  }

  /**
   * Fee rate to use when neither the caller nor the node supplied a usable one.
   * `sendRgb`/`createUtxos` previously forwarded `undefined` (WDK's own 3 sat/vB
   * default) or a bare `?? 1`, so mainnet RGB spends could build below the floor
   * the engine defines for exactly this case.
   */
  private defaultFeeRate(): number {
    return this.network === 'mainnet' ? MAINNET_FEE_FLOOR.normal : 1
  }

  async estimateRgbFee(blocks: number): Promise<{ fee_rate: number }> {
    this.assertConnected()
    const res: any = await this.account.estimateFee({ blocks })
    return { fee_rate: res?.fee_rate ?? 1 }
  }

  async getRgbDetailedBalance(): Promise<{
    vanilla: { settled: number; future: number; spendable: number }
    colored: { settled: number; future: number; spendable: number }
  }> {
    this.assertConnected()
    const balance: any = await this.account.getBtcBalance()
    const empty = { settled: 0, future: 0, spendable: 0 }
    return { vanilla: balance?.vanilla ?? empty, colored: balance?.colored ?? empty }
  }

  // --- Swaps (Option C: the adapter owns swaps, delegating to the WDK maker module) -------
  /** Lazily bind the KaleidoSwap maker client to this connected account. */
  private ensureSwap(): KaleidoswapSwap {
    this.assertConnected()
    if (!this.makerUrl) {
      throw new ProtocolError('RLN swaps require a makerUrl in the adapter config', 'RGB_LN', 'CONFIG')
    }
    if (!this.swap) this.swap = new KaleidoswapSwap(this.account, { baseUrl: this.makerUrl })
    return this.swap
  }

  /**
   * Quote a cross-asset swap via the KaleidoSwap maker RFQ. `QuoteRequest` carries
   * no layer hints, so callers pass `fromLayer`/`toLayer` as extra fields;
   * they default to the RGB-LN layers.
   */
  async getSwapQuote(request: QuoteRequest): Promise<Quote> {
    const req = request as SwapQuoteRequest
    return this.ensureSwap().getQuote({
      ...request,
      fromLayer: req.fromLayer ?? 'RGB_LN',
      toLayer: req.toLayer ?? 'RGB_LN',
    })
  }

  /**
   * Execute an approved quote as an atomic swap. The maker binds execution to the
   * quote's rfq id and exact raw amounts; settlement is an HTLC to this adapter's
   * own node — no receiver address, no deposit leg.
   */
  async executeSwap(quote: Quote): Promise<SwapResult> {
    return this.ensureSwap().executeSwap(quote)
  }

  /** `swapId` is the atomic swap's payment hash. */
  async getSwapStatus(swapId: string, accessToken?: string): Promise<SwapResult> {
    return this.ensureSwap().getSwapStatus(swapId, accessToken)
  }

  // --- Escape hatch -------------------------------------------------------
  /** Generic escape hatch for RLN-specific ops not on the core contract (allowlisted). */
  async executeProtocolOperation(operation: string, params: any): Promise<any> {
    // Node-side signMessage must honor the same LNURL-auth phishing guard as
    // the local signers — a signature over the canonical phrase compromises
    // the node's LNURL-auth identity.
    if (operation === 'signMessage') {
      const message = typeof params === 'string' ? params : params?.message
      if (typeof message === 'string') assertSafeToSign(message)
    }
    if (RLN_PRIVILEGED_OPS.has(operation)) {
      if (!this.allowPrivilegedOps) {
        throw new ProtocolError(
          `Operation '${operation}' moves funds and requires allowPrivilegedOps in the adapter config`,
          'RGB_LN',
          'PRIVILEGED_OP'
        )
      }
      return this.runAllowlistedOp(RLN_PRIVILEGED_OPS, operation, params)
    }
    return this.runAllowlistedOp(RLN_ALLOWED_OPS, operation, params)
  }
}
