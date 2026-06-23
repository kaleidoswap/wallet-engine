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
 * Wired against @utexo/wdk-wallet-rgb@2.0.3's published types:
 *   - WalletManagerRgb(seed, RgbWalletConfig).getAccount() → WalletAccountRgb
 *   - account: getAddress / registerWallet()→{address,btcBalance} / listAssets()
 *     (sync array) / receiveAsset / transfer(TransferOptions) / createUtxos /
 *     signPsbt / refreshWallet / syncWallet / listTransfers / listTransactions.
 *   - NO invoice decoder, NO Lightning, NO swaps on the WDK account surface.
 * Per-asset balance rides on listAssets(); BTC balance rides on registerWallet().
 * Response field names (InvoiceReceiveData, BtcBalance, ListAssetsResponse) are
 * read defensively and should still be smoke-tested on-device.
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
import { BaseWdkAdapter } from './BaseWdkAdapter'

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

export class RgbLibWdkAdapter extends BaseWdkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'RGB_L1'
  readonly capabilities = PROTOCOL_OPERATIONS.RGB_L1
  readonly supportedLayers: Layer[] = getCapabilities('RGB_L1').layers

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

  async getConnectionInfo(): Promise<ConnectionInfo> {
    this.assertConnected()
    return { protocol: 'RGB_L1', connected: this.connected, network: this.network }
  }

  // --- Address / receive --------------------------------------------------
  async getReceiveAddress(assetId?: string): Promise<Address> {
    this.assertConnected()
    if (assetId) {
      // receiveAsset requires an amount + a witness flag; 0 = "any amount".
      const inv: any = await this.account.receiveAsset({ assetId, amount: 0, witness: true })
      return { address: inv?.invoice ?? '', format: 'RGB_INVOICE', asset: assetId }
    }
    // The base account exposes getAddress(); registerWallet() also returns it.
    const address: string =
      (await this.account.getAddress?.()) ?? (await this.account.registerWallet()).address
    return { address, format: 'BTC_ADDRESS' }
  }

  // --- Balance ------------------------------------------------------------
  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    this.assertConnected()
    // The WDK account has no standalone BTC-balance call; registerWallet()
    // returns { address, btcBalance }. btcBalance is the rgb-lib vanilla/colored
    // split; read the vanilla (uncolored) sats.
    const reg: any = await this.account.registerWallet()
    const v = reg?.btcBalance?.vanilla ?? reg?.btcBalance ?? {}
    const settled = Number(v.settled ?? 0)
    const spendable = Number(v.spendable ?? settled)
    return { confirmed: settled, unconfirmed: Math.max(0, Number(v.future ?? spendable) - settled), total: spendable }
  }

  async refreshBalances(): Promise<void> {
    this.assertConnected()
    // refreshWallet()/syncWallet() are synchronous void on the WDK account.
    try {
      this.account.refreshWallet?.()
      this.account.syncWallet?.()
    } catch {
      /* best-effort */
    }
  }

  async listAssets(): Promise<UnifiedAsset[]> {
    this.assertConnected()
    const { total } = await this.getBtcBalance()
    const out: UnifiedAsset[] = [rgbBtcAsset(total, RGB_L1_PROFILE)]

    // listAssets() is synchronous and returns the asset array directly (it may
    // also come wrapped as { nia, cfa, uda } depending on rgb-sdk version).
    const res: any = await this.account.listAssets()
    const assets: any[] = Array.isArray(res) ? res : res?.nia ?? res?.assets?.nia ?? []
    for (const a of assets) out.push(rgbNiaAsset(normalizeAsset(a), RGB_L1_PROFILE))
    return out
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    this.assertConnected()
    // No standalone balance call; the per-asset balance rides on listAssets().
    const a = (await this.listAssets()).find((x) => x.id === assetId)
    return a?.balance ?? rgbAssetBalance({})
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
      amount: request.assetAmount ?? 0, // amount is required; 0 = any amount
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

  async decodeInvoice(_invoice: string): Promise<DecodedInvoice> {
    // The WDK account does not expose an invoice decoder; decoding would require
    // dropping to getRgbWallet() (the underlying rgb-sdk). Not supported here.
    throw new ProtocolError('RGB-L1 adapter does not decode invoices', 'RGB_L1', 'NOT_SUPPORTED')
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
  /**
   * BTC-L1 (vanilla) transaction history from rgb-lib. `listTransactions()` is
   * synchronous and returns the wallet's Bitcoin transactions; RGB asset detail
   * is per-asset via `listTransfers({ asset_id })`. Fields are read defensively.
   */
  async listTransactions(_filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    this.assertConnected()
    const raw: any = await this.account.listTransactions()
    const txs: any[] = Array.isArray(raw) ? raw : raw?.transactions ?? []
    return txs.map((t) => {
      const received = Number(t.received ?? 0)
      const sent = Number(t.sent ?? 0)
      const confTime = t.confirmation_time ?? t.confirmationTime
      return {
        id: t.txid ?? t.transaction_id ?? '',
        type: (received >= sent ? 'receive' : 'send') as UnifiedTransaction['type'],
        status: (confTime ? 'confirmed' : 'pending') as TransactionStatus,
        timestamp: Number(confTime?.timestamp ?? 0) * 1000,
        amount: Math.abs(received - sent) || received || sent,
        amountDisplay: '',
        asset: undefined as unknown as UnifiedAsset,
        protocolData: t,
      }
    })
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    const found = (await this.listTransactions()).find((t) => t.id === txId)
    if (!found) throw new ProtocolError(`Unknown tx ${txId}`, 'RGB_L1', 'NO_TX')
    return found
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

  /**
   * Sign a PSBT with the wallet's keys (rgb-lib signs wallet-owned inputs).
   * Returns the contract's `{ psbt, unchanged }` shape.
   */
  async signPsbt(psbtHex: string): Promise<{ psbt: string; unchanged: boolean }> {
    this.assertConnected()
    const signed: string = await this.account.signPsbt(psbtHex)
    return { psbt: signed ?? psbtHex, unchanged: !signed || signed === psbtHex }
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

}

/**
 * Normalize an rgb-sdk asset record (which may use camelCase `assetId` or
 * snake_case `asset_id`) into the shape `RgbCore.rgbNiaAsset` expects.
 */
function normalizeAsset(a: any): {
  asset_id: string
  name?: string
  ticker?: string
  precision?: number | string
  balance?: { spendable?: number; settled?: number; future?: number }
} {
  return {
    asset_id: a?.assetId ?? a?.asset_id ?? a?.id ?? '',
    name: a?.name,
    ticker: a?.ticker,
    precision: a?.precision,
    balance: a?.balance,
  }
}
