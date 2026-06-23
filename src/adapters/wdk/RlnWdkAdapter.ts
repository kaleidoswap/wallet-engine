/**
 * RlnWdkAdapter
 * -------------
 * Wraps the WDK RGB-Lightning module (@kaleidorg/wdk-wallet-rln, over kaleido-sdk)
 * onto the stable `IProtocolAdapter` contract. This is the RGB path: BTC on-chain,
 * BTC Lightning, RGB assets (USDT/XAUT) on-chain and over Lightning, plus channels
 * and atomic swaps.
 *
 * The RLN account talks to a remote RGB-Lightning node over HTTP (nodeUrl).
 *
 * Discipline: no WDK/kaleido-sdk types cross the contract — domain types only;
 * node responses are read as `any` and translated.
 *
 * WDK RLN surface (from types/index.d.ts): getAddress, getBalance, getBtcBalance,
 * sendBtc, listAssets({nia,uda,cfa}), getAssetBalance, sendRgb, createLNInvoice,
 * createRgbInvoice, sendPayment, getInvoiceStatus, decodeLNInvoice/decodeRgbInvoice,
 * listChannels/openChannel/closeChannel, listPeers/connectPeer, atomicTaker/listSwaps.
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

export interface RlnAdapterConfig extends BaseProtocolConfig {
  protocol: 'RGB'
  /** BIP-39 mnemonic for this wallet. */
  mnemonic: string
  /** Base URL of the RLN HTTP API (e.g. http://localhost:3001). */
  nodeUrl: string
  /** BIP-44 account index (default 0). */
  accountIndex?: number
}

/** Map RLN node status strings → domain TransactionStatus. */
function mapStatus(s?: string): TransactionStatus {
  const v = (s ?? '').toLowerCase()
  if (v.includes('succeed') || v.includes('settled') || v === 'paid') return 'confirmed'
  if (v.includes('fail')) return 'failed'
  return 'pending'
}

export class RlnWdkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'RGB'
  readonly capabilities = PROTOCOL_OPERATIONS.RGB
  readonly supportedLayers: Layer[] = getCapabilities('RGB').layers
  readonly version = '0.1.0-wdk'

  private manager: any = null
  private account: any = null
  private connected = false
  private network = 'mainnet'

  // --- Connection ---------------------------------------------------------
  async connect(config: BaseProtocolConfig): Promise<void> {
    const cfg = config as RlnAdapterConfig
    if (!cfg.mnemonic) throw new ProtocolError('RlnWdkAdapter requires a mnemonic', 'RGB', 'CONFIG')
    if (!cfg.nodeUrl) throw new ProtocolError('RlnWdkAdapter requires a nodeUrl', 'RGB', 'CONFIG')
    this.network = cfg.network ?? 'mainnet'
    // @ts-ignore — declared as a workspace/optional dep; resolved at runtime.
    const mod = await loadWdkModule('@kaleidorg/wdk-wallet-rln', () => import('@kaleidorg/wdk-wallet-rln'))
    const RlnWalletManager = mod.default ?? mod
    this.manager = new RlnWalletManager(cfg.mnemonic, { nodeUrl: cfg.nodeUrl })
    this.account = await this.manager.getAccount(cfg.accountIndex ?? 0)
    this.connected = true
  }

  async disconnect(): Promise<void> {
    try {
      this.account?.dispose?.()
      this.manager?.dispose?.()
    } finally {
      this.account = null
      this.manager = null
      this.connected = false
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    this.assertConnected()
    const info: any = await this.account.getNodeInfo()
    return {
      protocol: 'RGB',
      connected: this.connected,
      nodeId: info?.pubkey,
      network: this.network,
    }
  }

  // --- Address / receive --------------------------------------------------
  async getReceiveAddress(assetId?: string): Promise<Address> {
    this.assertConnected()
    if (assetId) {
      // RGB receive = an RGB invoice bound to the asset.
      const inv: any = await this.account.createRgbInvoice({ assetId })
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
    const out: UnifiedAsset[] = []

    // BTC
    const { total } = await this.getBtcBalance()
    out.push({
      id: 'BTC',
      name: 'Bitcoin',
      ticker: 'BTC',
      precision: 8,
      protocol: 'RGB',
      layer: 'BTC_L1',
      balance: { total, available: total, pending: 0, totalDisplay: String(total), availableDisplay: String(total) },
      capabilities: { canSend: true, canReceive: true, canSwap: true, supportsLightning: true, supportsOnchain: true },
    })

    // RGB assets (NIA — fungible: USDT/XAUT)
    const res: any = await this.account.listAssets(['Nia'])
    const nia: any[] = res?.nia ?? []
    for (const a of nia) {
      const bal = a?.balance ?? {}
      const total = Number(bal.spendable ?? bal.settled ?? 0)
      out.push({
        id: a.asset_id,
        name: a.name ?? a.ticker ?? a.asset_id,
        ticker: a.ticker ?? a.asset_id?.slice(0, 6),
        precision: Number(a.precision ?? 0),
        protocol: 'RGB',
        layer: 'RGB_LN',
        balance: { total, available: total, pending: 0, totalDisplay: String(total), availableDisplay: String(total) },
        capabilities: { canSend: true, canReceive: true, canSwap: true, supportsLightning: true, supportsOnchain: true },
      })
    }
    return out
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    this.assertConnected()
    const b: any = await this.account.getAssetBalance(assetId)
    const total = Number(b?.spendable ?? b?.settled ?? 0)
    return { total, available: total, pending: Number(b?.future ?? 0), totalDisplay: String(total), availableDisplay: String(total) }
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets()
    const found = assets.find((a) => a.id === assetId)
    if (!found) throw new ProtocolError(`Unknown asset ${assetId}`, 'RGB', 'NO_ASSET')
    return found
  }

  // --- Invoices -----------------------------------------------------------
  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    this.assertConnected()
    // RGB asset invoice (on-chain or LN) when an asset is specified.
    if (request.asset && request.asset !== 'BTC') {
      const inv: any = await this.account.createRgbInvoice({
        assetId: request.asset,
        amount: request.assetAmount,
        durationSeconds: request.expirySeconds,
      })
      return {
        invoice: inv?.invoice ?? '',
        paymentHash: inv?.recipient_id ?? '',
        amount: request.assetAmount,
        expiresAt: inv?.expiration_timestamp ? inv.expiration_timestamp * 1000 : Date.now() + (request.expirySeconds ?? 3600) * 1000,
        description: request.description,
      }
    }
    // BTC Lightning invoice.
    const inv: any = await this.account.createLNInvoice({
      amtMsat: request.amount != null ? request.amount * 1000 : undefined,
      description: request.description,
      expirySec: request.expirySeconds,
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
    const isBolt11 = /^ln(bc|tb|bcrt)/i.test(invoice.trim())
    const d: any = isBolt11
      ? await this.account.decodeLNInvoice(invoice)
      : await this.account.decodeRgbInvoice(invoice)
    return {
      paymentHash: d?.payment_hash ?? d?.recipient_id ?? '',
      amount: d?.amount_msat != null ? Math.floor(d.amount_msat / 1000) : d?.amount,
      amountMsat: d?.amount_msat,
      description: d?.description,
      expiresAt: d?.expiry_sec ? Date.now() + d.expiry_sec * 1000 : (d?.expiration_timestamp ?? 0) * 1000,
      destination: d?.payee_pubkey ?? d?.recipient_id ?? '',
      asset_id: d?.asset_id,
      asset_amount: d?.asset_amount,
    }
  }

  // --- Send ---------------------------------------------------------------
  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    this.assertConnected()
    // Pays a BOLT11 or RGB-LN invoice through the node.
    const r: any = await this.account.sendPayment({ invoice: request.invoice.trim() })
    return {
      paymentHash: r?.payment_hash ?? '',
      preimage: r?.payment_secret,
      amount: Number(request.amount ?? 0),
      fee: 0,
      status: mapStatus(r?.status),
      timestamp: Date.now(),
    }
  }

  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    this.assertConnected()
    const s: any = await this.account.getInvoiceStatus({ paymentHash })
    return { paymentHash, status: mapStatus(s?.status), error: s?.error }
  }

  // --- Transactions / payments -------------------------------------------
  async listTransactions(_filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    this.assertConnected()
    const r: any = await this.account.listTransactions()
    const txs: any[] = r?.transactions ?? []
    return txs.map((t) => ({
      id: t.txid ?? t.transaction_id ?? '',
      type: (t.transaction_type === 'User' || t.amount < 0 ? 'send' : 'receive') as UnifiedTransaction['type'],
      status: (t.confirmation_time ? 'confirmed' : 'pending') as TransactionStatus,
      timestamp: (t.confirmation_time?.timestamp ?? 0) * 1000,
      amount: Number(t.received ?? t.sent ?? 0),
      amountDisplay: '',
      asset: undefined as unknown as UnifiedAsset,
      protocolData: t,
    }))
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    const all = await this.listTransactions()
    const found = all.find((t) => t.id === txId)
    if (!found) throw new ProtocolError(`Unknown tx ${txId}`, 'RGB', 'NO_TX')
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
    return this.account.createRgbInvoice(params)
  }

  async decodeRgbInvoice(params: any): Promise<any> {
    this.assertConnected()
    return this.account.decodeRgbInvoice(params?.invoice ?? params)
  }

  async getInvoiceStatus(params: { invoice: string }): Promise<any> {
    this.assertConnected()
    // Best-effort: decode to a payment hash, then query status.
    const d: any = await this.account.decodeLNInvoice(params.invoice).catch(() => null)
    const paymentHash = d?.payment_hash
    if (!paymentHash) return { status: 'unknown' }
    return this.account.getInvoiceStatus({ paymentHash })
  }

  async sendAsset(params: { recipientMap: Record<string, any[]>; feeRate?: number; donation?: boolean; minConfirmations?: number }): Promise<any> {
    this.assertConnected()
    return this.account.sendRgb(params)
  }

  async sendBtcOnchain(params: { address: string; amount: number; feeRate?: number }): Promise<any> {
    this.assertConnected()
    await this.account.sendBtc(params)
    return { ok: true }
  }

  // --- Swaps --------------------------------------------------------------
  supportsSwaps(): boolean {
    return getCapabilities('RGB').supportsSwaps
  }

  /** Generic escape hatch for RLN-specific ops not on the core contract. */
  async executeProtocolOperation(operation: string, params: any): Promise<any> {
    this.assertConnected()
    const fn = (this.account as any)[operation]
    if (typeof fn !== 'function') {
      throw new ProtocolError(`Unknown RLN operation '${operation}'`, 'RGB', 'NO_OP')
    }
    return fn.call(this.account, params)
  }

  // --- helpers ------------------------------------------------------------
  private assertConnected(): void {
    if (!this.connected || !this.account) {
      throw new ProtocolError('RlnWdkAdapter not connected', 'RGB', 'NOT_CONNECTED')
    }
  }
}
