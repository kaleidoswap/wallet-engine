/**
 * Arkade Protocol Adapter
 * Implements IProtocolAdapter using @arkade-os/sdk.
 * Ported from rate-extension, adapted for React Native with Expo providers.
 */

import { IProtocolAdapter, BaseProtocolConfig } from './IProtocolAdapter'
import { arkadeClientManager } from '../lib/arkade-client-manager'
import { ArkadeConfig } from '../types/arkade'
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
  QuoteRequest,
  Quote,
  SwapResult,
  ProtocolError,
  ConnectionError,
  TransactionStatus,
} from '../types/base'
import { PROTOCOL_OPERATIONS } from '../capabilities/operations'

export class ArkadeAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'ARKADE'
  readonly capabilities = PROTOCOL_OPERATIONS.ARKADE
  readonly supportedLayers: Layer[] = ['BTC_ARKADE', 'BTC_L1', 'ARKADE_ARKADE']
  readonly version = '1.0.0'

  private config: ArkadeConfig | null = null

  // ========================================================================
  // Connection Management
  // ========================================================================

  async connect(config: BaseProtocolConfig): Promise<void> {
    const arkadeConfig = config as ArkadeConfig

    if (!arkadeConfig.mnemonic) {
      throw new ConnectionError('Mnemonic is required for Arkade wallet', 'ARKADE')
    }
    if (!arkadeConfig.arkServerUrl) {
      throw new ConnectionError('arkServerUrl is required for Arkade wallet', 'ARKADE')
    }

    try {
      await arkadeClientManager.initialize(arkadeConfig)
      this.config = arkadeConfig
      console.log('[ArkadeAdapter] Connected to Arkade successfully')
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new ConnectionError(`Failed to connect to Arkade: ${msg}`, 'ARKADE')
    }
  }

  async disconnect(): Promise<void> {
    await arkadeClientManager.disconnect()
    this.config = null
    console.log('[ArkadeAdapter] Disconnected from Arkade')
  }

  isConnected(): boolean {
    return arkadeClientManager.isInitialized()
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'ARKADE', 'NOT_CONNECTED')
    }
    return {
      protocol: 'ARKADE',
      connected: true,
      network: this.config?.network ?? 'signet',
      syncStatus: { synced: true, progress: 100 },
    }
  }

  // ========================================================================
  // Asset Operations
  // ========================================================================

  async listAssets(): Promise<UnifiedAsset[]> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'ARKADE', 'NOT_CONNECTED')
    }
    try {
      const wallet = arkadeClientManager.getWallet()
      const balance = await wallet.getBalance()
      const totalSats = this.toNumber(balance?.total)
      const availableSats = this.toNumber(balance?.available)
      const preconfirmed = this.toNumber(balance?.preconfirmed)

      return [{
        id: 'BTC',
        name: 'Bitcoin (Arkade)',
        ticker: 'BTC',
        precision: 8,
        protocol: 'ARKADE',
        layer: 'BTC_ARKADE',
        balance: {
          total: totalSats,
          available: availableSats,
          pending: preconfirmed,
          locked: 0,
          totalDisplay: this.formatSats(totalSats),
          availableDisplay: this.formatSats(availableSats),
        },
        capabilities: {
          canSend: true,
          canReceive: true,
          canSwap: false,
          supportsLightning: false,
          supportsOnchain: true,
        },
        metadata: {
          boarding: this.toNumber(balance?.boarding?.total),
          settled: this.toNumber(balance?.settled),
          preconfirmed,
          recoverable: this.toNumber(balance?.recoverable),
        },
      }]
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new ProtocolError(`Failed to list assets: ${msg}`, 'ARKADE', 'LIST_ASSETS_ERROR')
    }
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets()
    const asset = assets.find(a => a.id === assetId || a.ticker === assetId)
    if (!asset) {
      throw new ProtocolError(`Asset not found: ${assetId}`, 'ARKADE', 'ASSET_NOT_FOUND')
    }
    return asset
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    const asset = await this.getAsset(assetId)
    return asset.balance
  }

  async refreshBalances(): Promise<void> {}

  // ========================================================================
  // Transaction Operations
  // ========================================================================

  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'ARKADE', 'NOT_CONNECTED')
    }
    try {
      const wallet = arkadeClientManager.getWallet()
      const history: any[] = await wallet.getTransactionHistory()

      return (history ?? [])
        .map((item: any) => this.convertArkTx(item))
        .filter((tx): tx is UnifiedTransaction => tx !== null)
        .filter(tx => {
          if (!filter) return true
          if (filter.type && tx.type !== filter.type) return false
          if (filter.status && tx.status !== filter.status) return false
          return true
        })
        .slice(filter?.offset ?? 0, filter?.limit ? (filter.offset ?? 0) + filter.limit : undefined)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new ProtocolError(`Failed to list transactions: ${msg}`, 'ARKADE', 'LIST_TRANSACTIONS_ERROR')
    }
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    const txs = await this.listTransactions()
    const tx = txs.find(t => t.id === txId)
    if (!tx) {
      throw new ProtocolError(`Transaction not found: ${txId}`, 'ARKADE', 'TX_NOT_FOUND')
    }
    return tx
  }

  // ========================================================================
  // Payment Operations
  // ========================================================================

  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'ARKADE', 'NOT_CONNECTED')
    }
    const wallet = arkadeClientManager.getWallet()
    const address: string = await wallet.getAddress()
    return {
      invoice: address,
      paymentHash: '',
      amount: request.amount,
      expiresAt: Date.now() + (request.expirySeconds ?? 3600) * 1000,
      description: request.description ?? 'Arkade receiving address',
    }
  }

  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    return { paymentHash: '', expiresAt: 0, destination: invoice }
  }

  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'ARKADE', 'NOT_CONNECTED')
    }
    if (!request.amount || request.amount <= 0) {
      throw new ProtocolError('Amount is required for Arkade payments', 'ARKADE', 'INVALID_AMOUNT')
    }
    try {
      const wallet = arkadeClientManager.getWallet()
      const txid: string = await wallet.sendBitcoin({
        address: request.invoice,
        amount: request.amount,
      })
      return {
        paymentHash: txid,
        amount: request.amount,
        fee: 0,
        status: 'confirmed' as TransactionStatus,
        timestamp: Date.now(),
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new ProtocolError(`Failed to send payment: ${msg}`, 'ARKADE', 'SEND_PAYMENT_ERROR')
    }
  }

  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    return { paymentHash, status: 'pending' as TransactionStatus }
  }

  // ========================================================================
  // Address Operations
  // ========================================================================

  async getReceiveAddress(assetId?: string): Promise<Address> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'ARKADE', 'NOT_CONNECTED')
    }
    const wallet = arkadeClientManager.getWallet()

    if (assetId === 'onchain' || assetId === 'boarding') {
      const address: string = await wallet.getBoardingAddress()
      return { address, format: 'BTC_ADDRESS', asset: 'BTC' }
    }

    const address: string = await wallet.getAddress()
    return { address, format: 'ARKADE_ADDRESS', asset: 'BTC' }
  }

  // ========================================================================
  // Node & Balance Operations
  // ========================================================================

  async getNodeInfo(): Promise<any> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'ARKADE', 'NOT_CONNECTED')
    }
    const wallet = arkadeClientManager.getWallet()
    const balance = await wallet.getBalance()
    const spendable = this.toNumber(balance?.available)
    return {
      channelsBalanceMsat: spendable * 1000,
      maxPayableMsat: spendable * 1000,
      onchainBalanceMsat: this.toNumber(balance?.boarding?.total) * 1000,
      pendingOnchainBalanceMsat: 0,
      maxReceivableMsat: 0,
      inboundLiquidityMsats: 0,
      connectedPeers: [],
      utxos: 0,
    }
  }

  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'ARKADE', 'NOT_CONNECTED')
    }
    const wallet = arkadeClientManager.getWallet()
    const balance = await wallet.getBalance()
    const confirmed = this.toNumber(balance?.available)
    const total = this.toNumber(balance?.total)
    return { confirmed, unconfirmed: Math.max(total - confirmed, 0), total }
  }

  async listChannels(): Promise<[]> { return [] }
  async listPayments(): Promise<any> { return { payments: await this.listTransactions() } }
  async listTransfers(_options?: { asset_id?: string }): Promise<any> { return { transfers: [] } }

  // ========================================================================
  // Unsupported Operations
  // ========================================================================

  supportsSwaps(): boolean { return false }

  async sendBtcOnchain(params: { address: string; amount: number }): Promise<any> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'ARKADE', 'NOT_CONNECTED')
    }
    const wallet = arkadeClientManager.getWallet()
    const txid: string = await wallet.sendBitcoin({ address: params.address, amount: params.amount })
    return { txid }
  }

  // ========================================================================
  // Private Helpers
  // ========================================================================

  private convertArkTx(tx: any): UnifiedTransaction | null {
    try {
      const isSend = tx.type === 'SENT'
      const amountSats: number = tx.amount ?? 0
      const timestamp: number = typeof tx.createdAt === 'number' ? tx.createdAt
        : tx.createdAt instanceof Date ? tx.createdAt.getTime()
        : Date.now()

      const txId = tx.key?.arkTxid || tx.key?.commitmentTxid || tx.key?.boardingTxid || tx.txid || `ark-${timestamp}`

      const btcAsset: UnifiedAsset = {
        id: 'BTC', name: 'Bitcoin (Ark)', ticker: 'BTC', precision: 8,
        protocol: 'ARKADE', layer: 'ARKADE_ARKADE',
        balance: {
          total: amountSats, available: amountSats, pending: 0,
          totalDisplay: this.formatSats(amountSats),
          availableDisplay: this.formatSats(amountSats),
        },
        capabilities: { canSend: true, canReceive: true, canSwap: false, supportsLightning: false, supportsOnchain: true },
      }

      return {
        id: txId,
        type: isSend ? 'send' : 'receive',
        status: tx.settled || !isSend ? 'confirmed' : 'pending',
        timestamp, amount: amountSats,
        amountDisplay: this.formatSats(amountSats),
        fee: 0, feeDisplay: '0.00000000',
        asset: btcAsset,
        protocolData: { type: tx.type, settled: tx.settled, key: tx.key },
      }
    } catch { return null }
  }

  private toNumber(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'bigint') return Number(value)
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : 0
    }
    return 0
  }

  private formatSats(sats: number): string {
    return (sats / 1e8).toFixed(8)
  }
}
