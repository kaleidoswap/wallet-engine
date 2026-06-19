/**
 * ArkadeWdkAdapter
 * ----------------
 * Wraps the Arkade WDK module (@arkade-os/wdk, over @arkade-os/sdk + boltz-swap)
 * onto the stable `IProtocolAdapter` contract. Arkade is a VTXO-based Bitcoin L2:
 * off-chain Ark transfers, an on-chain "boarding" address for funding, and Lightning
 * receive via Boltz reverse submarine swaps.
 *
 * Discipline: no WDK/@arkade-os types cross the contract — domain types only;
 * module objects are read as `any`.
 *
 * Arkade WDK surface (from JSDoc in the cloned source, v0.1.3):
 *   read-only: getAddress(): string (Ark address, inherited), getBoardingAddress(): string,
 *              getBalance(): bigint, getTokenBalance(id): bigint, getTransactionHistory()
 *   account:   sendTransaction({to,value}), transfer({token,recipient,amount}),
 *              createLightningInvoice(amountSats, description?): {invoice,paymentHash},
 *              waitForLightningPayment(invoice): {txid}, getLightningLimits/Fees,
 *              subscribeToIncomingFunds, sign, dispose
 *   NOTE: Lightning *send* (pay a BOLT11) is not exposed as a simple method in v0.1.3.
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
import { loadWdkModule } from './moduleLoader'
import { decodeBolt11, isBolt11 } from '../../lib/bolt11'

const isBitcoinAddress = (value: string): boolean => /^(bc1|tb1|bcrt1)/i.test(value.trim())

export interface ArkadeAdapterConfig extends BaseProtocolConfig {
  protocol: 'ARKADE'
  /** BIP-39 mnemonic for this wallet. */
  mnemonic: string
  /** BIP-44 account index (default 0). */
  accountIndex?: number
  /** Arkade wallet config (ark server URL, indexer URL, swap provider URL, …) passed through to the module. */
  arkadeConfig?: Record<string, any>
}

export class ArkadeWdkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'ARKADE'
  readonly supportedLayers: Layer[] = getCapabilities('ARKADE').layers
  readonly version = '0.1.0-wdk'

  private manager: any = null
  private account: any = null
  private connected = false
  private network = 'mainnet'

  // --- Connection ---------------------------------------------------------
  async connect(config: BaseProtocolConfig): Promise<void> {
    const cfg = config as ArkadeAdapterConfig
    if (!cfg.mnemonic) throw new ProtocolError('ArkadeWdkAdapter requires a mnemonic', 'ARKADE', 'CONFIG')
    this.network = cfg.network ?? 'mainnet'
    // @ts-ignore — external module, resolved at runtime in the consuming app.
    const mod = await loadWdkModule('@arkade-os/wdk', () => import('@arkade-os/wdk'))
    const WalletManagerArkade = mod.default ?? mod.WalletManagerArkade ?? mod
    this.manager = new WalletManagerArkade(cfg.mnemonic, cfg.arkadeConfig ?? {})
    this.account = await this.manager.getAccount(cfg.accountIndex ?? 0)
    this.connected = true
  }

  async disconnect(): Promise<void> {
    try {
      this.account?.dispose?.()
      await this.manager?.dispose?.()
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
    return { protocol: 'ARKADE', connected: this.connected, network: this.network }
  }

  // --- Address / receive --------------------------------------------------
  /** Default Ark address. For the on-chain boarding address use `getBoardingAddress`. */
  async getReceiveAddress(_assetId?: string): Promise<Address> {
    this.assertConnected()
    const address: string = await this.account.getAddress()
    return { address, format: 'ARKADE_ADDRESS' }
  }

  /** On-chain BTC boarding address for funding the Arkade account. */
  async getBoardingAddress(): Promise<Address> {
    this.assertConnected()
    const address: string = await this.account.getBoardingAddress()
    return { address, format: 'BTC_ADDRESS' }
  }

  // --- Balance ------------------------------------------------------------
  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    this.assertConnected()
    const bal: bigint = await this.account.getBalance()
    const total = Number(bal)
    return { confirmed: total, unconfirmed: 0, total }
  }

  async refreshBalances(): Promise<void> {
    // Arkade syncs against the indexer on read; no explicit sync call.
  }

  async listAssets(): Promise<UnifiedAsset[]> {
    this.assertConnected()
    const { total } = await this.getBtcBalance()
    const btc: UnifiedAsset = {
      id: 'BTC',
      name: 'Bitcoin',
      ticker: 'BTC',
      precision: 8,
      protocol: 'ARKADE',
      layer: 'BTC_ARKADE',
      balance: { total, available: total, pending: 0, totalDisplay: String(total), availableDisplay: String(total) },
      capabilities: { canSend: true, canReceive: true, canSwap: false, supportsLightning: true, supportsOnchain: true },
    }
    // Arkade exposes getTokenBalance(id) but no token enumeration → BTC only here.
    return [btc]
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
    if (!found) throw new ProtocolError(`Unknown asset ${assetId}`, 'ARKADE', 'NO_ASSET')
    return found
  }

  // --- Invoices -----------------------------------------------------------
  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    this.assertConnected()
    if (request.layer === 'BTC_LN' || request.amount != null) {
      // createLightningInvoice(amountSats, description?) — POSITIONAL args; via Boltz reverse swap.
      const r: any = await this.account.createLightningInvoice(request.amount ?? 0, request.description)
      return {
        invoice: r?.invoice ?? '',
        paymentHash: r?.paymentHash ?? '',
        amount: request.amount,
        expiresAt: Date.now() + (request.expirySeconds ?? 3600) * 1000,
        description: request.description,
      }
    }
    throw new ProtocolError('Arkade on-chain receive uses getReceiveAddress/getBoardingAddress', 'ARKADE', 'NOT_SUPPORTED')
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
    if (/^ln(bc|tb|bcrt)/i.test(dest)) {
      // Lightning send via Boltz submarine swap is not exposed as a simple method in v0.1.3.
      throw new ProtocolError('Arkade Lightning send not available in this module version', 'ARKADE', 'NOT_SUPPORTED')
    }
    if (request.amount == null) {
      throw new ProtocolError('Arkade send requires an explicit amount', 'ARKADE', 'NO_AMOUNT')
    }
    // Bitcoin destination → on-chain offboard. Route through sendBtcOnchain so the
    // missing-tx-id guard and async `pending` status apply regardless of entry point
    // (otherwise a BTC offboard with no hash would falsely report success).
    if (isBitcoinAddress(dest)) {
      return this.sendBtcOnchain({ address: dest, amount: request.amount })
    }
    // Off-chain Ark transfer to an Ark address (settles immediately, zero-conf UX).
    const r: any = await this.account.sendTransaction({ to: dest, value: request.amount })
    const hash = r?.hash ?? ''
    return {
      paymentHash: hash,
      txid: hash,
      amount: request.amount,
      fee: Number(r?.fee ?? 0),
      status: 'confirmed',
      timestamp: Date.now(),
    }
  }

  /** Arkade BTC send/offboard. Bitcoin destinations settle on-chain asynchronously. */
  async sendBtcOnchain(params: { address: string; amount: number; feeRate?: number }): Promise<PaymentResult> {
    this.assertConnected()
    const r: any = await this.account.sendTransaction({ to: params.address.trim(), value: params.amount })
    const hash = r?.hash ?? ''
    if (!hash) {
      throw new ProtocolError('Arkade offboard did not return a transaction ID', 'ARKADE', 'SEND_ERROR')
    }
    return {
      txid: hash,
      paymentHash: hash,
      amount: params.amount,
      fee: Number(r?.fee ?? 0),
      status: 'pending',
      timestamp: Date.now(),
    }
  }

  /** Arkade asset transfer (token). */
  async sendAsset(params: { token: string; recipient: string; amount: number }): Promise<any> {
    this.assertConnected()
    return this.account.transfer({ token: params.token, recipient: params.recipient, amount: params.amount })
  }

  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    this.assertConnected()
    const r: any = await this.account.getTransactionReceipt?.(paymentHash).catch(() => null)
    const status = (r?.confirmedAt || r?.settled ? 'confirmed' : 'pending') as TransactionStatus
    return { paymentHash, status }
  }

  // --- Transactions -------------------------------------------------------
  async listTransactions(_filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    this.assertConnected()
    const history: any[] = await this.account.getTransactionHistory()
    return (history ?? []).map((t) => {
      // @arkade-os/sdk ArkTransaction shape:
      //   { key:{ arkTxid, commitmentTxid, boardingTxid }, type:'SENT'|'RECEIVED',
      //     amount(sats, net), settled(boolean), createdAt(ms since epoch) }.
      // The txid lives on `key` (the unused fields are empty strings, so we must
      // pick the first NON-EMPTY one — `??` would stop at `''`). Direction is the
      // explicit `type`, not the amount sign (amount is reported as a magnitude).
      // `createdAt` is already milliseconds; the old `* 1000` pushed every entry
      // ~50k years into the future, breaking sort order and the displayed date.
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
        asset: undefined as unknown as UnifiedAsset,
        protocolData: t,
      }
    })
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    const all = await this.listTransactions()
    const found = all.find((t) => t.id === txId)
    if (!found) throw new ProtocolError(`Unknown tx ${txId}`, 'ARKADE', 'NO_TX')
    return found
  }

  async getNodeInfo(): Promise<any> {
    return { protocol: 'ARKADE', network: this.network }
  }

  async listChannels(): Promise<any[]> {
    return [] // Arkade has no LN channels (LN via Boltz swaps)
  }

  async listPayments(): Promise<any> {
    return this.listTransactions()
  }

  async listTransfers(): Promise<any> {
    return this.account.getTransactionHistory()
  }

  supportsSwaps(): boolean {
    return getCapabilities('ARKADE').supportsSwaps
  }

  /** Escape hatch for Arkade-specific ops (waitForLightningPayment, getLightningLimits, …). */
  async executeProtocolOperation(operation: string, params: any): Promise<any> {
    this.assertConnected()
    const fn = (this.account as any)[operation]
    if (typeof fn !== 'function') {
      throw new ProtocolError(`Unknown Arkade operation '${operation}'`, 'ARKADE', 'NO_OP')
    }
    return fn.call(this.account, params)
  }

  // --- helpers ------------------------------------------------------------
  private assertConnected(): void {
    if (!this.connected || !this.account) {
      throw new ProtocolError('ArkadeWdkAdapter not connected', 'ARKADE', 'NOT_CONNECTED')
    }
  }
}
