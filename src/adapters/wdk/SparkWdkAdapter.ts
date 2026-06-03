/**
 * SparkWdkAdapter
 * ---------------
 * Thin adapter mapping the WDK Spark module (@tetherto/wdk-wallet-spark) onto the
 * stable `IProtocolAdapter` contract. This is the reference implementation of the
 * "wrap a WDK module behind the contract" pattern (see docs/WDK_INTEGRATION_PLAN.md).
 *
 * Discipline rules enforced here:
 *  - NO WDK/SDK types cross the contract boundary — everything returned is a domain
 *    type from ../types/base. The WDK objects are held as `any` internally.
 *  - Protocol quirks (zero-fee, static address) live in the capability manifest,
 *    not in this interface.
 *
 * WDK Spark account surface (captured via Spike A, 2026-06-03):
 *   manager: getAccount, getAccountByPath, getFeeRates
 *   account: getAddress, getBalance, sendTransaction, transfer,
 *            getStaticDepositAddress, getSingleUseDepositAddress, quoteWithdraw,
 *            withdraw, createLightningInvoice, payLightningInvoice,
 *            createSparkSatsInvoice, createSparkTokensInvoice, paySparkInvoice,
 *            syncWalletBalance, dispose, cleanupConnections
 *
 * Status: skeleton — core receive/balance/invoice/send wired to the real WDK calls;
 * remaining contract methods stubbed with explicit ProtocolError until Phase 2.
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
  ProtocolError,
} from '../../types/base'
import { getCapabilities } from '../../capabilities'
import { loadWdkModule } from './moduleLoader'

export interface SparkAdapterConfig extends BaseProtocolConfig {
  protocol: 'SPARK'
  /** BIP-39 mnemonic for this wallet. */
  mnemonic: string
  /** BIP-44 account index (default 0). */
  accountIndex?: number
}

/** Local mirror of the WDK Spark network union (kept here so WDK types never cross the contract). */
type SparkNetwork = 'MAINNET' | 'TESTNET' | 'REGTEST' | 'SIGNET' | 'LOCAL'

const SPARK_NETWORK_MAP: Record<string, SparkNetwork> = {
  mainnet: 'MAINNET',
  testnet: 'TESTNET',
  regtest: 'REGTEST',
  signet: 'SIGNET', // Spark supports SIGNET natively
}

export class SparkWdkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'SPARK'
  readonly supportedLayers: Layer[] = getCapabilities('SPARK').layers
  readonly version = '0.1.0-wdk'

  private manager: any = null
  private account: any = null
  private connected = false
  private network = 'mainnet'

  // --- Connection ---------------------------------------------------------
  async connect(config: BaseProtocolConfig): Promise<void> {
    const cfg = config as SparkAdapterConfig
    if (!cfg.mnemonic) {
      throw new ProtocolError('SparkWdkAdapter requires a mnemonic', 'SPARK', 'CONFIG')
    }
    this.network = cfg.network ?? 'mainnet'
    // Injectable loader (RN injects a static require; Node/Vite use the import fallback).
    // @ts-ignore — declared as a workspace/optional dep; resolved at runtime.
    const mod = await loadWdkModule('@tetherto/wdk-wallet-spark', () => import('@tetherto/wdk-wallet-spark'))
    const WalletManagerSpark = mod.default ?? mod
    this.manager = new WalletManagerSpark(cfg.mnemonic, {
      network: SPARK_NETWORK_MAP[this.network] ?? 'MAINNET',
    })
    this.account = await this.manager.getAccount(cfg.accountIndex ?? 0)
    this.connected = true
  }

  async disconnect(): Promise<void> {
    try {
      await this.account?.dispose?.()
      await this.account?.cleanupConnections?.()
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
    return { protocol: 'SPARK', connected: this.connected, network: this.network }
  }

  // --- Address / receive --------------------------------------------------
  async getReceiveAddress(): Promise<Address> {
    this.assertConnected()
    const address = await this.account.getAddress()
    return { address, format: 'SPARK_ADDRESS' }
  }

  // --- Balance ------------------------------------------------------------
  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    this.assertConnected()
    // WDK: getBalance(): Promise<bigint> — sats, settled balance.
    const bal: bigint = await this.account.getBalance()
    const total = Number(bal)
    return { confirmed: total, unconfirmed: 0, total }
  }

  async refreshBalances(): Promise<void> {
    this.assertConnected()
    await this.account.syncWalletBalance?.()
  }

  async listAssets(): Promise<UnifiedAsset[]> {
    this.assertConnected()
    const { total } = await this.getBtcBalance()
    const btc: UnifiedAsset = {
      id: 'BTC',
      name: 'Bitcoin',
      ticker: 'BTC',
      precision: 8,
      protocol: 'SPARK',
      layer: 'BTC_SPARK',
      balance: {
        total,
        available: total,
        pending: 0,
        totalDisplay: String(total),
        availableDisplay: String(total),
      },
      capabilities: {
        canSend: true,
        canReceive: true,
        canSwap: false,
        supportsLightning: true,
        supportsOnchain: true,
      },
    }
    // TODO(Phase 2): enumerate Spark tokens from account.getBalance() token map.
    return [btc]
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    const assets = await this.listAssets()
    const found = assets.find((a) => a.id === assetId)
    if (!found) throw new ProtocolError(`Unknown asset ${assetId}`, 'SPARK', 'NO_ASSET')
    return found.balance
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets()
    const found = assets.find((a) => a.id === assetId)
    if (!found) throw new ProtocolError(`Unknown asset ${assetId}`, 'SPARK', 'NO_ASSET')
    return found
  }

  // --- Invoices / receive amounts ----------------------------------------
  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    this.assertConnected()
    const expiresAt = Date.now() + (request.expirySeconds ?? 3600) * 1000

    // 1) Lightning receive (BOLT11) — when the caller targets the LN layer.
    if (request.layer === 'BTC_LN') {
      // WDK createLightningInvoice({ amountSats, memo, expirySeconds }): LightningReceiveRequest
      const r: any = await this.account.createLightningInvoice({
        amountSats: request.amount ?? 0,
        memo: request.description,
        expirySeconds: request.expirySeconds,
      })
      const encoded = r?.invoice?.encodedInvoice ?? r?.encodedInvoice ?? r?.invoice ?? ''
      return {
        invoice: encoded,
        paymentHash: r?.invoice?.paymentHash ?? r?.id ?? '',
        amount: request.amount,
        expiresAt,
        description: request.description,
      }
    }

    // 2) Spark token invoice — returns a SparkAddressFormat string.
    if (request.asset && request.asset !== 'BTC') {
      const invoice: string = await this.account.createSparkTokensInvoice({
        tokenIdentifier: request.asset,
        amount: request.assetAmount != null ? BigInt(request.assetAmount) : undefined,
        memo: request.description,
      })
      return { invoice, paymentHash: '', amount: request.assetAmount, expiresAt, description: request.description }
    }

    // 3) Default: native Spark sats invoice — returns a SparkAddressFormat string.
    const invoice: string = await this.account.createSparkSatsInvoice({
      amount: request.amount,
      memo: request.description,
    })
    return { invoice, paymentHash: '', amount: request.amount, expiresAt, description: request.description }
  }

  // --- Send ---------------------------------------------------------------
  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    this.assertConnected()
    const dest = request.invoice.trim()
    const isBolt11 = /^ln(bc|tb|bcrt)/i.test(dest)
    const timestamp = Date.now()

    // 1) Lightning send — WDK requires a maxFeeSats cap.
    if (isBolt11) {
      const r: any = await this.account.payLightningInvoice({
        invoice: dest,
        maxFeeSats: request.maxFeeSats ?? this.defaultMaxFeeSats(request.amount),
      })
      return {
        paymentHash: r?.paymentHash ?? r?.id ?? '',
        preimage: r?.preimage,
        amount: Number(r?.amountSats ?? request.amount ?? 0),
        fee: Number(r?.feeSats ?? 0),
        status: 'confirmed',
        timestamp,
      }
    }

    // 2) Plain Spark address + explicit amount → direct transfer (zero-fee).
    if (request.amount != null) {
      const r: any = await this.account.sendTransaction({ to: dest, value: request.amount })
      return {
        paymentHash: r?.id ?? r?.transferId ?? '',
        amount: request.amount,
        fee: 0, // Spark transfers are zero-fee (capability flag)
        status: 'confirmed',
        timestamp,
      }
    }

    // 3) Encoded Spark invoice (amount embedded) → fulfill. Takes an ARRAY.
    const res: any = await this.account.paySparkInvoice([{ invoice: dest }])
    const ok = res?.satsTransactionSuccess?.[0]
    return {
      paymentHash: ok?.transferResponse?.id ?? '',
      amount: Number(request.amount ?? 0),
      fee: 0,
      status: ok ? 'confirmed' : 'failed',
      timestamp,
    }
  }

  /** Conservative default LN fee cap: 0.5% of amount, min 5 sats. */
  private defaultMaxFeeSats(amount?: number): number {
    if (!amount || amount <= 0) return 10
    return Math.max(5, Math.ceil(amount * 0.005))
  }

  // --- Contract methods stubbed until Phase 2 -----------------------------
  async decodeInvoice(_invoice: string): Promise<DecodedInvoice> {
    throw this.notImplemented('decodeInvoice')
  }
  async getPaymentStatus(_paymentHash: string): Promise<PaymentStatus> {
    throw this.notImplemented('getPaymentStatus')
  }
  async listTransactions(_filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    throw this.notImplemented('listTransactions')
  }
  async getTransaction(_txId: string): Promise<UnifiedTransaction> {
    throw this.notImplemented('getTransaction')
  }
  async getNodeInfo(): Promise<any> {
    return { protocol: 'SPARK', network: this.network }
  }
  async listChannels(): Promise<any[]> {
    return [] // Spark has no LN channels
  }
  async listPayments(): Promise<any> {
    throw this.notImplemented('listPayments')
  }
  async listTransfers(): Promise<any> {
    throw this.notImplemented('listTransfers')
  }
  supportsSwaps(): boolean {
    return getCapabilities('SPARK').supportsSwaps
  }

  // --- helpers ------------------------------------------------------------
  private assertConnected(): void {
    if (!this.connected || !this.account) {
      throw new ProtocolError('SparkWdkAdapter not connected', 'SPARK', 'NOT_CONNECTED')
    }
  }
  private notImplemented(method: string): ProtocolError {
    return new ProtocolError(`SparkWdkAdapter.${method} not implemented (Phase 2)`, 'SPARK', 'NOT_IMPLEMENTED')
  }
}
