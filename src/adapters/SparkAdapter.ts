/**
 * Spark Protocol Adapter
 * Implements IProtocolAdapter using @buildonspark/spark-sdk.
 * Ported from rate-extension for React Native.
 */

import { IProtocolAdapter, BaseProtocolConfig } from './IProtocolAdapter'
import { sparkClientManager } from '../lib/spark-client-manager'
import { SparkConfig } from '../types/spark'
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

const DEFAULT_MAX_FEE_SATS = 1000

export class SparkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'SPARK'
  readonly supportedLayers: Layer[] = ['SPARK_SPARK', 'BTC_LN']
  readonly version = '1.0.0'

  private config: SparkConfig | null = null

  // ========================================================================
  // Connection Management
  // ========================================================================

  async connect(config: BaseProtocolConfig): Promise<void> {
    const sparkConfig = config as SparkConfig

    if (!sparkConfig.mnemonic) {
      throw new ConnectionError('Mnemonic is required for Spark wallet', 'SPARK')
    }

    try {
      await sparkClientManager.initialize(sparkConfig)
      this.config = sparkConfig
      console.log('[SparkAdapter] Connected to Spark successfully')
    } catch (error: any) {
      throw new ConnectionError(`Failed to connect to Spark: ${error.message}`, 'SPARK', error)
    }
  }

  async disconnect(): Promise<void> {
    await sparkClientManager.disconnect()
    this.config = null
    console.log('[SparkAdapter] Disconnected from Spark')
  }

  isConnected(): boolean {
    return sparkClientManager.isInitialized()
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'SPARK', 'NOT_CONNECTED')
    }

    try {
      const wallet = sparkClientManager.getWallet()
      await wallet.getBalance()

      return {
        protocol: 'SPARK',
        connected: true,
        network: this.config?.network || 'regtest',
        syncStatus: { synced: true, progress: 100 },
      }
    } catch (error: any) {
      throw new ProtocolError(`Failed to get connection info: ${error.message}`, 'SPARK', 'CONNECTION_INFO_ERROR', error)
    }
  }

  // ========================================================================
  // Asset Operations
  // ========================================================================

  async listAssets(): Promise<UnifiedAsset[]> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'SPARK', 'NOT_CONNECTED')
    }

    try {
      const wallet = sparkClientManager.getWallet()
      const { balance, tokenBalances } = await wallet.getBalance()
      const balanceSats = Number(balance)

      const btcAsset: UnifiedAsset = {
        id: 'BTC',
        name: 'Bitcoin',
        ticker: 'BTC',
        precision: 8,
        protocol: 'SPARK',
        layer: 'SPARK_SPARK',
        balance: {
          total: balanceSats,
          available: balanceSats,
          pending: 0,
          locked: 0,
          totalDisplay: this.formatAmount(balanceSats, 8),
          availableDisplay: this.formatAmount(balanceSats, 8),
        },
        capabilities: {
          canSend: true,
          canReceive: true,
          canSwap: false,
          supportsLightning: true,
          supportsOnchain: true,
        },
      }

      const assets: UnifiedAsset[] = [btcAsset]

      // Add token assets
      if (tokenBalances && tokenBalances.size > 0) {
        for (const [tokenId, info] of tokenBalances) {
          const { tokenMetadata: meta } = info
          const owned = Number(info.ownedBalance)
          const available = Number(info.availableToSendBalance)
          const precision = meta.decimals

          assets.push({
            id: tokenId,
            name: meta.tokenName,
            ticker: meta.tokenTicker,
            precision,
            protocol: 'SPARK',
            layer: 'SPARK_SPARK',
            balance: {
              total: owned,
              available,
              pending: 0,
              locked: owned - available,
              totalDisplay: this.formatAmount(owned, precision),
              availableDisplay: this.formatAmount(available, precision),
            },
            capabilities: {
              canSend: true,
              canReceive: true,
              canSwap: false,
              supportsLightning: false,
              supportsOnchain: false,
            },
          })
        }
      }

      return assets
    } catch (error: any) {
      throw new ProtocolError(`Failed to list assets: ${error.message}`, 'SPARK', 'LIST_ASSETS_ERROR')
    }
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets()
    const asset = assets.find(a => a.id === assetId || a.ticker === assetId)
    if (!asset) {
      throw new ProtocolError(`Asset not found: ${assetId}`, 'SPARK', 'ASSET_NOT_FOUND')
    }
    return asset
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    const asset = await this.getAsset(assetId)
    return asset.balance
  }

  async refreshBalances(): Promise<void> {
    // Balances are fetched live
  }

  // ========================================================================
  // Transaction Operations
  // ========================================================================

  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'SPARK', 'NOT_CONNECTED')
    }

    try {
      const wallet = sparkClientManager.getWallet()
      const { transfers } = await wallet.getTransfers(filter?.limit || 50, filter?.offset || 0)

      return (transfers || []).map((t: any) => this.convertTransfer(t)).filter(Boolean) as UnifiedTransaction[]
    } catch (error: any) {
      throw new ProtocolError(`Failed to list transactions: ${error.message}`, 'SPARK', 'LIST_TRANSACTIONS_ERROR')
    }
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'SPARK', 'NOT_CONNECTED')
    }

    try {
      const wallet = sparkClientManager.getWallet()
      const transfer = await wallet.getTransfer(txId)
      if (!transfer) {
        throw new ProtocolError(`Transaction not found: ${txId}`, 'SPARK', 'TX_NOT_FOUND')
      }
      const converted = this.convertTransfer(transfer)
      if (!converted) {
        throw new ProtocolError(`Failed to convert transaction: ${txId}`, 'SPARK', 'TX_CONVERT_ERROR')
      }
      return converted
    } catch (error: any) {
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError(`Failed to get transaction: ${error.message}`, 'SPARK', 'GET_TX_ERROR')
    }
  }

  // ========================================================================
  // Payment Operations
  // ========================================================================

  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'SPARK', 'NOT_CONNECTED')
    }

    try {
      const wallet = sparkClientManager.getWallet()
      const result = await wallet.createLightningInvoice({
        amountSats: request.amount || 0,
        memo: request.description,
      })

      const invoice = result.invoice
      return {
        invoice: invoice.encodedInvoice,
        paymentHash: invoice.paymentHash || '',
        amount: request.amount,
        expiresAt: invoice.expiryTime ? new Date(invoice.expiryTime).getTime() : Date.now() + 3600000,
        description: request.description,
      }
    } catch (error: any) {
      throw new ProtocolError(`Failed to create invoice: ${error.message}`, 'SPARK', 'CREATE_INVOICE_ERROR')
    }
  }

  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    // Spark SDK doesn't have a decode method; return basic parsed info
    return {
      paymentHash: '',
      expiresAt: 0,
      destination: invoice,
    }
  }

  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'SPARK', 'NOT_CONNECTED')
    }

    try {
      const wallet = sparkClientManager.getWallet()

      // Detect if this is a Lightning invoice or Spark address
      const isLightning = request.invoice.toLowerCase().startsWith('ln')
      let result: any

      if (isLightning) {
        result = await wallet.payLightningInvoice({
          invoice: request.invoice,
          maxFeeSats: DEFAULT_MAX_FEE_SATS,
          // Required by the Spark SDK for 0-amount (amountless) invoices; for
          // invoices that already carry an amount this must be omitted.
          ...(request.amount && request.amount > 0 ? { amountSatsToSend: request.amount } : {}),
        })
      } else {
        // Spark-to-Spark transfer
        result = await wallet.transfer({
          receiverSparkAddress: request.invoice,
          amountSats: request.amount || 0,
        })
      }

      return {
        paymentHash: result?.id || '',
        amount: request.amount || 0,
        fee: 0,
        status: 'confirmed' as TransactionStatus,
        timestamp: Date.now(),
      }
    } catch (error: any) {
      throw new ProtocolError(`Failed to send payment: ${error.message}`, 'SPARK', 'SEND_PAYMENT_ERROR')
    }
  }

  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    return {
      paymentHash,
      status: 'pending' as TransactionStatus,
    }
  }

  // ========================================================================
  // Address Operations
  // ========================================================================

  async getReceiveAddress(assetId?: string): Promise<Address> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'SPARK', 'NOT_CONNECTED')
    }

    try {
      const wallet = sparkClientManager.getWallet()

      if (assetId === 'onchain' || assetId === 'btc_onchain') {
        const address = await wallet.getSingleUseDepositAddress()
        return { address, format: 'BTC_ADDRESS', asset: 'BTC' }
      }

      const address = await wallet.getSparkAddress()
      return { address, format: 'SPARK_ADDRESS', asset: 'BTC' }
    } catch (error: any) {
      throw new ProtocolError(`Failed to get address: ${error.message}`, 'SPARK', 'GET_ADDRESS_ERROR')
    }
  }

  // ========================================================================
  // Node & Balance Operations
  // ========================================================================

  async getNodeInfo(): Promise<any> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'SPARK', 'NOT_CONNECTED')
    }

    const wallet = sparkClientManager.getWallet()
    const { balance } = await wallet.getBalance()
    const balanceSats = Number(balance)

    return {
      channelsBalanceMsat: balanceSats * 1000,
      maxPayableMsat: balanceSats * 1000,
      onchainBalanceMsat: 0,
      maxReceivableMsat: 0,
      inboundLiquidityMsats: 0,
      connectedPeers: [],
      blockHeight: 0,
      pendingOnchainBalanceMsat: 0,
      utxos: 0,
    }
  }

  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'SPARK', 'NOT_CONNECTED')
    }

    const wallet = sparkClientManager.getWallet()
    const { balance } = await wallet.getBalance()
    const balanceSats = Number(balance)

    return { confirmed: balanceSats, unconfirmed: 0, total: balanceSats }
  }

  async listChannels(): Promise<[]> {
    return []
  }

  async listPayments(): Promise<any> {
    const txs = await this.listTransactions()
    return { payments: txs }
  }

  async listTransfers(_options?: { asset_id?: string }): Promise<any> {
    return { transfers: [] }
  }

  // ========================================================================
  // Unsupported Operations
  // ========================================================================

  supportsSwaps(): boolean {
    return false
  }

  async sendBtcOnchain(params: { address: string; amount: number }): Promise<any> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'SPARK', 'NOT_CONNECTED')
    }

    const wallet = sparkClientManager.getWallet()
    const result = await wallet.withdraw({
      onchainAddress: params.address,
      amountSats: params.amount,
      exitSpeed: 'FAST',
    })
    return result
  }

  // ========================================================================
  // Private Helpers
  // ========================================================================

  private convertTransfer(transfer: any): UnifiedTransaction | null {
    try {
      const isIncoming = transfer.transferDirection === 'INCOMING'
      const amountSats = Number(transfer.totalValue || 0)
      const timestamp = transfer.createdTime ? new Date(transfer.createdTime).getTime() : Date.now()

      const statusMap: Record<string, TransactionStatus> = {
        'TRANSFER_STATUS_COMPLETED': 'confirmed',
        'TRANSFER_STATUS_RETURNED': 'failed',
        'TRANSFER_STATUS_EXPIRED': 'cancelled',
      }

      const btcAsset: UnifiedAsset = {
        id: 'BTC',
        name: 'Bitcoin',
        ticker: 'BTC',
        precision: 8,
        protocol: 'SPARK',
        layer: 'SPARK_SPARK',
        balance: {
          total: amountSats,
          available: amountSats,
          pending: 0,
          totalDisplay: this.formatAmount(amountSats, 8),
          availableDisplay: this.formatAmount(amountSats, 8),
        },
        capabilities: {
          canSend: true, canReceive: true, canSwap: false,
          supportsLightning: true, supportsOnchain: true,
        },
      }

      return {
        id: transfer.id,
        type: isIncoming ? 'receive' : 'send',
        status: statusMap[transfer.status] || 'pending',
        timestamp,
        amount: amountSats,
        amountDisplay: this.formatAmount(amountSats, 8),
        fee: 0,
        asset: btcAsset,
        protocolData: { sparkTransfer: transfer },
      }
    } catch {
      return null
    }
  }

  private formatAmount(amount: number, precision: number): string {
    return (amount / Math.pow(10, precision)).toFixed(precision)
  }
}
