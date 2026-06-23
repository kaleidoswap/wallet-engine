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

/** Well-known Liquid mainnet Tether USD (USDt) asset id — the lite-mode "USD". */
export const LIQUID_USDT_ASSET_ID =
  'ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2'

export interface LiquidAdapterConfig extends BaseProtocolConfig {
  protocol: 'LIQUID'
  /** BIP-39 mnemonic for this wallet. */
  mnemonic: string
  /** BIP-44 account index (default 0). */
  accountIndex?: number
  /** Optional Esplora base URL override. */
  esploraUrl?: string
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

export class LiquidWdkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'LIQUID'
  readonly capabilities = PROTOCOL_OPERATIONS.LIQUID
  readonly supportedLayers: Layer[] = getCapabilities('LIQUID').layers
  readonly version = '0.1.0-wdk'

  private manager: any = null
  private account: any = null
  private connected = false
  private network = 'mainnet'
  private policyAsset: string | null = null

  // --- Connection ---------------------------------------------------------
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
    })
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
      this.policyAsset = null
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    this.assertConnected()
    const info = await this.account.getNetworkInfo()
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
    const address = await this.account.getAddress()
    return { address, format: 'LIQUID_ADDRESS', asset: assetId }
  }

  // --- Balance ------------------------------------------------------------
  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    this.assertConnected()
    const bal: bigint = await this.account.getBalance() // L-BTC sats
    const total = Number(bal)
    return { confirmed: total, unconfirmed: 0, total }
  }

  async refreshBalances(): Promise<void> {
    // lwk syncs against Esplora on read; no explicit sync call.
  }

  async listAssets(): Promise<UnifiedAsset[]> {
    this.assertConnected()
    const policy = await this.getPolicyAsset()
    const out: UnifiedAsset[] = []

    // L-BTC (policy asset)
    const { total } = await this.getBtcBalance()
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
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    this.assertConnected()
    const bal: bigint = await this.account.getTokenBalance(assetId)
    const n = Number(bal)
    return { total: n, available: n, pending: 0, totalDisplay: String(n), availableDisplay: String(n) }
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
    const r: any = await this.account.transfer({ recipient: request.invoice.trim(), amount: request.amount })
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
    const r: any = await this.account.sendAsset({
      assetId: params.assetId,
      recipient: params.address,
      amount: params.amount,
      feeRate: params.feeRate,
    })
    return { paymentHash: r?.hash ?? '', fee: Number(r?.fee ?? 0), amount: params.amount, status: 'pending' as TransactionStatus }
  }

  /** L-BTC on-chain send (alias of sendPayment's transfer). */
  async sendBtcOnchain(params: { address: string; amount: number; feeRate?: number }): Promise<any> {
    this.assertConnected()
    const r: any = await this.account.transfer({ recipient: params.address, amount: params.amount, feeRate: params.feeRate })
    return { txid: r?.hash ?? '', fee: Number(r?.fee ?? 0) }
  }

  // --- Transactions -------------------------------------------------------
  async listTransactions(_filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    this.assertConnected()
    const txs: Array<{ txid: string; type: string; fee: string; height: number | null; timestamp: number | null }> =
      await this.account.listTransactions()
    return txs.map((t) => ({
      id: t.txid,
      type: t.type === 'outgoing' ? 'send' : 'receive',
      status: (t.height != null ? 'confirmed' : 'pending') as TransactionStatus,
      timestamp: (t.timestamp ?? 0) * 1000,
      amount: 0, // lwk tx summary carries no net value here; enrich in Phase 3 from unspents/deltas
      amountDisplay: '',
      fee: Number(t.fee ?? 0),
      asset: undefined as unknown as UnifiedAsset, // TODO(Phase 3): resolve per-tx asset
      protocolData: { height: t.height },
    }))
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
    return this.account.getNetworkInfo()
  }

  async getBtcBalanceConfirmed(): Promise<number> {
    return (await this.getBtcBalance()).total
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
    return this.account.listTransactions()
  }
  supportsSwaps(): boolean {
    return getCapabilities('LIQUID').supportsSwaps
  }

  // --- helpers ------------------------------------------------------------
  private async getPolicyAsset(): Promise<string> {
    if (this.policyAsset) return this.policyAsset
    const info = await this.account.getNetworkInfo()
    const policy: string = info?.policy_asset ?? ''
    this.policyAsset = policy
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
      balance: { total: n, available: n, pending: 0, totalDisplay: String(n), availableDisplay: String(n) },
      capabilities: {
        canSend: true,
        canReceive: true,
        canSwap: false,
        supportsLightning: false,
        supportsOnchain: true,
      },
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.account) {
      throw new ProtocolError('LiquidWdkAdapter not connected', 'LIQUID', 'NOT_CONNECTED')
    }
  }
}
