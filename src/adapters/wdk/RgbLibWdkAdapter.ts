/**
 * RgbLibWdkAdapter
 * ----------------
 * Wraps the local rgb-lib WDK module (@utexo/wdk-wallet-rgb) onto the stable
 * `IProtocolAdapter` contract as the RGB-L1 (on-chain) path: BTC on-chain + RGB
 * assets on-chain, with NO Lightning, channels, or swaps. It is the on-chain
 * subset of the node-backed `RlnWdkAdapter`; the two share their asset/balance/
 * status translation via `RgbCore` so they cannot drift.
 *
 * Unlike the RLN adapter (which talks to a remote rgb-lightning-node over HTTP),
 * this runs rgb-lib locally and holds keys in-process — that's why it lives in
 * the wallet engine rather than in the remote-client kaleido-sdk.
 *
 * Discipline: no WDK/rgb-lib types cross the contract — domain types only; the
 * module account is read as `any` and translated.
 *
 * NOTE: the exact rgb-lib method names/response shapes are read defensively
 * (optional chaining + fallbacks) and should be validated on-device against the
 * installed @utexo/wdk-wallet-rgb version.
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
  NodeInfo,
  ProtocolError,
} from '../../types/base'
import { getCapabilities } from '../../capabilities'
import { PROTOCOL_OPERATIONS } from '../../capabilities/operations'
import { loadWdkModule } from './moduleLoader'
import { rgbBtcAsset, rgbNiaAsset, rgbAssetBalance, RGB_L1_PROFILE } from './RgbCore'

export interface RgbLibAdapterConfig extends BaseProtocolConfig {
  protocol: 'RGB_L1'
  /** BIP-39 mnemonic for this wallet. */
  mnemonic: string
  /** Persistent directory for the rgb-lib SQLite wallet + data. */
  dataDir: string
  /** RGB indexer (electrum/esplora) URL. */
  indexerUrl?: string
  /** RGB proxy / transport endpoint. */
  transportEndpoint?: string
}

export class RgbLibWdkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'RGB_L1'
  readonly capabilities = PROTOCOL_OPERATIONS.RGB_L1
  readonly supportedLayers: Layer[] = getCapabilities('RGB_L1').layers
  readonly version = '0.1.0-wdk'

  private manager: any = null
  private account: any = null
  private connected = false
  private network = 'mainnet'

  // --- Connection ---------------------------------------------------------
  async connect(config: BaseProtocolConfig): Promise<void> {
    const cfg = config as RgbLibAdapterConfig
    if (!cfg.mnemonic) throw new ProtocolError('RgbLibWdkAdapter requires a mnemonic', 'RGB_L1', 'CONFIG')
    if (!cfg.dataDir) throw new ProtocolError('RgbLibWdkAdapter requires a dataDir', 'RGB_L1', 'CONFIG')
    this.network = cfg.network ?? 'mainnet'
    // @ts-ignore — declared as an optional dep; resolved at runtime.
    const mod = await loadWdkModule('@utexo/wdk-wallet-rgb', () => import('@utexo/wdk-wallet-rgb'))
    const WalletManagerRgb = mod.WalletManagerRgb ?? mod.default ?? mod
    this.manager = new WalletManagerRgb(cfg.mnemonic, {
      network: this.network,
      dataDir: cfg.dataDir,
      indexerUrl: cfg.indexerUrl,
      transportEndpoint: cfg.transportEndpoint,
    })
    this.account = await this.manager.getAccount()
    // rgb-lib needs the wallet registered with the indexer before first use.
    await this.account.registerWallet?.().catch(() => {})
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
    return { protocol: 'RGB_L1', connected: this.connected, network: this.network }
  }

  // --- Address / receive --------------------------------------------------
  async getReceiveAddress(assetId?: string): Promise<Address> {
    this.assertConnected()
    if (assetId) {
      const inv: any = await this.account.receiveAsset({ assetId, witness: true })
      return { address: inv?.invoice ?? '', format: 'RGB_INVOICE', asset: assetId }
    }
    const address: string = await this.account.getAddress()
    return { address, format: 'BTC_ADDRESS' }
  }

  // --- Balance ------------------------------------------------------------
  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    this.assertConnected()
    const b: any = (await this.account.getBtcBalance?.()) ?? (await this.account.registerWallet?.()) ?? {}
    // rgb-lib exposes a vanilla/colored split; fall back to a flat shape or btcBalance.
    const v = b?.vanilla ?? b ?? {}
    const settled = Number(v.settled ?? b.btcBalance ?? 0)
    const spendable = Number(v.spendable ?? settled)
    return { confirmed: settled, unconfirmed: Math.max(0, Number(v.future ?? spendable) - settled), total: spendable }
  }

  async refreshBalances(): Promise<void> {
    this.assertConnected()
    await (this.account.refreshWallet?.() ?? this.account.syncWallet?.())?.catch?.(() => {})
  }

  async listAssets(): Promise<UnifiedAsset[]> {
    this.assertConnected()
    const { total } = await this.getBtcBalance()
    const out: UnifiedAsset[] = [rgbBtcAsset(total, RGB_L1_PROFILE)]

    const res: any = await this.account.listAssets()
    const nia: any[] = res?.nia ?? res?.assets?.nia ?? []
    for (const a of nia) out.push(rgbNiaAsset(a, RGB_L1_PROFILE))
    return out
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    this.assertConnected()
    const b: any = await this.account.getAssetBalance(assetId)
    return rgbAssetBalance(b)
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets()
    const found = assets.find((a) => a.id === assetId)
    if (!found) throw new ProtocolError(`Unknown asset ${assetId}`, 'RGB_L1', 'NO_ASSET')
    return found
  }

  // --- Invoices -----------------------------------------------------------
  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    this.assertConnected()
    // RGB-L1 has no Lightning: only RGB asset invoices are supported.
    if (!request.asset || request.asset === 'BTC') {
      throw new ProtocolError('RGB-L1 has no Lightning invoices; use getReceiveAddress for BTC', 'RGB_L1', 'NOT_SUPPORTED')
    }
    const inv: any = await this.account.receiveAsset({
      assetId: request.asset,
      amount: request.assetAmount,
      witness: true,
    })
    return {
      invoice: inv?.invoice ?? '',
      paymentHash: inv?.recipientId ?? inv?.recipient_id ?? '',
      amount: request.assetAmount,
      expiresAt: inv?.expirationTimestamp ? inv.expirationTimestamp * 1000 : Date.now() + (request.expirySeconds ?? 3600) * 1000,
      description: request.description,
    }
  }

  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    this.assertConnected()
    const d: any = await this.account.decodeRGBInvoice({ invoice })
    return {
      paymentHash: d?.recipientId ?? d?.recipient_id ?? '',
      amount: d?.amount,
      description: d?.description,
      expiresAt: (d?.expirationTimestamp ?? d?.expiration_timestamp ?? 0) * 1000,
      destination: d?.recipientId ?? d?.recipient_id ?? '',
      asset_id: d?.assetId ?? d?.asset_id,
      asset_amount: d?.amount,
    }
  }

  // --- Send ---------------------------------------------------------------
  async sendPayment(_request: PaymentRequest): Promise<PaymentResult> {
    // No Lightning on RGB-L1; on-chain sends go through sendAsset / sendBtcOnchain.
    throw new ProtocolError('RGB-L1 has no Lightning send; use sendAsset or sendBtcOnchain', 'RGB_L1', 'NOT_SUPPORTED')
  }

  async getPaymentStatus(_paymentHash: string): Promise<PaymentStatus> {
    throw new ProtocolError('RGB-L1 has no Lightning payment status', 'RGB_L1', 'NOT_SUPPORTED')
  }

  // --- Transactions -------------------------------------------------------
  async listTransactions(_filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    this.assertConnected()
    // rgb-lib transfers are per-asset; a unified on-chain history is not exposed
    // as a single call. Callers should use listTransfers({ asset_id }) for detail.
    return []
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    throw new ProtocolError(`Unknown tx ${txId}`, 'RGB_L1', 'NO_TX')
  }

  async getNodeInfo(): Promise<NodeInfo> {
    // No node: RGB-L1 is a local rgb-lib wallet.
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
    if (!options?.asset_id) return { transfers: [] }
    return this.account.listTransfers(options.asset_id)
  }

  // --- Optional RGB-specific hooks ----------------------------------------
  async createRgbInvoice(params: any): Promise<any> {
    this.assertConnected()
    return this.account.receiveAsset(params)
  }

  async decodeRgbInvoice(params: any): Promise<any> {
    this.assertConnected()
    return this.account.decodeRGBInvoice(params?.invoice ? params : { invoice: params })
  }

  async createRgbUtxos(params: { num?: number; size?: number; feeRate?: number; upTo?: boolean }): Promise<{ success: boolean }> {
    this.assertConnected()
    await this.account.createUtxos(params)
    return { success: true }
  }

  async sendAsset(params: { token: string; recipient: string; amount: number; feeRate?: number; minConfirmations?: number }): Promise<any> {
    this.assertConnected()
    return this.account.transfer(params)
  }

  async sendBtcOnchain(params: { address: string; amount: number; feeRate?: number }): Promise<any> {
    this.assertConnected()
    await this.account.sendTransaction({ to: params.address, value: params.amount, feeRate: params.feeRate })
    return { ok: true }
  }

  // --- Swaps --------------------------------------------------------------
  supportsSwaps(): boolean {
    return getCapabilities('RGB_L1').supportsSwaps // false
  }

  // --- helpers ------------------------------------------------------------
  private assertConnected(): void {
    if (!this.connected || !this.account) {
      throw new ProtocolError('RgbLibWdkAdapter not connected', 'RGB_L1', 'NOT_CONNECTED')
    }
  }
}
