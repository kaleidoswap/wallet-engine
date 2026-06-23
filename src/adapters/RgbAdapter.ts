/**
 * RGB Protocol Adapter
 * Uses kaleido-sdk to implement the protocol adapter interface.
 * Ported from rate-extension/src/protocols/adapters/RgbAdapter.ts
 */

import { IProtocolAdapter, BaseProtocolConfig } from './IProtocolAdapter'
import { kaleidoClientManager } from '../lib/kaleido-client-manager'
import type {
  CreateSwapOrderRequest,
  CreateSwapOrderResponse,
  SwapOrderStatusResponse,
} from 'kaleido-sdk'
import {
  KaleidoError,
  APIError,
  NetworkError,
  NodeNotConfiguredError,
  QuoteExpiredError,
  InsufficientBalanceError as SdkInsufficientBalanceError,
  Layer as SdkLayer,
} from 'kaleido-sdk'
import type {
  AssetBalanceResponse,
  BtcBalanceResponse,
  CreateLNInvoiceResponse,
  DecodeLNInvoiceResponse,
  SendPaymentResponse,
  LNInvoiceRequest,
  ListTransfersResponse,
} from 'kaleido-sdk/rln'
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
  InsufficientBalanceError,
  TransactionType,
  TransactionStatus,
} from '../types/base'
import { RgbConfig } from '../types/rgb'
import { PROTOCOL_OPERATIONS } from '../capabilities/operations'

export class RgbAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'RGB_LN'
  readonly capabilities = PROTOCOL_OPERATIONS.RGB_LN
  readonly supportedLayers: Layer[] = ['RGB_L1', 'RGB_LN', 'BTC_L1', 'BTC_LN']
  readonly version = '1.0.0'

  private connected = false
  private config: RgbConfig | null = null
  private swapAccessTokens = new Map<string, string>()

  // ========================================================================
  // Connection Management
  // ========================================================================

  async connect(config: BaseProtocolConfig): Promise<void> {
    const rgbConfig = config as RgbConfig

    if (!rgbConfig.nodeUrl) {
      throw new ConnectionError('Node URL is required', 'RGB_LN')
    }

    try {
      kaleidoClientManager.initialize({
        baseUrl: rgbConfig.makerUrl || '',
        nodeUrl: rgbConfig.nodeUrl,
        apiKey: rgbConfig.apiKey,
      })

      const client = kaleidoClientManager.getClient()
      await client.rln.getNodeInfo()

      this.config = rgbConfig
      this.connected = true
      console.log('[RgbAdapter] Connected to RGB node via kaleido-sdk')

      // Test maker connection (non-blocking)
      if (rgbConfig.makerUrl) {
        try {
          await client.maker.listAssets()
          console.log('[RgbAdapter] Maker API accessible')
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error)
          console.warn('[RgbAdapter] Maker API not accessible (swaps will show error):', msg)
        }
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new ConnectionError(`Failed to connect to RGB node: ${msg}`, 'RGB_LN', error)
    }
  }

  async disconnect(): Promise<void> {
    kaleidoClientManager.reset()
    this.connected = false
    this.config = null
    console.log('[RgbAdapter] Disconnected')
  }

  isConnected(): boolean {
    return this.connected && kaleidoClientManager.isInitialized()
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'RGB_LN', 'NOT_CONNECTED')
    }

    const info: ConnectionInfo = {
      protocol: 'RGB_LN',
      connected: true,
      network: this.config?.network || 'regtest',
    }

    if (kaleidoClientManager.hasNode()) {
      try {
        const client = kaleidoClientManager.getClient()
        const nodeInfo = await client.rln.getNodeInfo()
        const networkInfo = await client.rln.getNetworkInfo()
        info.nodeId = (nodeInfo as any).pubkey || ''
        info.blockHeight = (networkInfo as any).height || 0
        info.syncStatus = { synced: true, progress: 100 }
      } catch (error) {
        console.warn('[RgbAdapter] Could not get node info:', error)
      }
    }

    return info
  }

  // ========================================================================
  // Asset Operations
  // ========================================================================

  async listAssets(): Promise<UnifiedAsset[]> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'RGB_LN', 'NOT_CONNECTED')
    }

    const client = kaleidoClientManager.getClient()
    let nodeAssetsArray: Record<string, unknown>[] = []

    if (kaleidoClientManager.hasNode()) {
      try {
        const nodeAssets = await client.rln.listAssets()
        const response = nodeAssets as { nia?: Record<string, unknown>[]; uda?: Record<string, unknown>[]; cfa?: Record<string, unknown>[] }
        nodeAssetsArray = [
          ...(response.nia || []),
          ...(response.uda || []),
          ...(response.cfa || []),
        ]
      } catch (error) {
        console.warn('[RgbAdapter] Could not get node assets:', error)
      }
    }

    if (nodeAssetsArray.length === 0) {
      // Return at least BTC if no RGB assets
      try {
        const btcBalance = await client.rln.getBtcBalance()
        return [this.createBtcAsset(btcBalance)]
      } catch {
        return []
      }
    }

    // Add BTC as first asset
    const assets: UnifiedAsset[] = []
    try {
      const btcBalance = await client.rln.getBtcBalance()
      assets.push(this.createBtcAsset(btcBalance))
    } catch {
      // Skip BTC if balance check fails
    }

    assets.push(...nodeAssetsArray.map(a => this.convertNodeAssetToUnified(a)))
    return assets
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets()
    const asset = assets.find(a => a.id === assetId || a.ticker === assetId)
    if (!asset) {
      throw new ProtocolError(`Asset not found: ${assetId}`, 'RGB_LN', 'ASSET_NOT_FOUND')
    }
    return asset
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }

    try {
      const client = kaleidoClientManager.getClient()

      if (assetId === 'BTC' || assetId.toLowerCase() === 'btc') {
        const btcBalance = await client.rln.getBtcBalance()
        return this.convertBtcBalance(btcBalance)
      }

      const balanceData = await client.rln.getAssetBalance({ asset_id: assetId })
      return this.convertSdkBalance(balanceData)
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to get asset balance')
    }
  }

  async refreshBalances(): Promise<void> {}

  // ========================================================================
  // Transaction Operations
  // ========================================================================

  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }

    try {
      const client = kaleidoClientManager.getClient()

      if (!filter?.asset) {
        throw new ProtocolError('Asset ID is required for listing RGB transfers', 'RGB_LN', 'ASSET_ID_REQUIRED')
      }

      const response = await client.rln.listTransfers({ asset_id: filter.asset }) as { transfers?: Record<string, unknown>[] }
      const transfers = response.transfers || []

      return transfers
        .map(t => this.convertTransferToTransaction(t))
        .filter(tx => {
          if (!filter) return true
          if (filter.type && tx.type !== filter.type) return false
          if (filter.status && tx.status !== filter.status) return false
          if (filter.fromTimestamp && tx.timestamp < filter.fromTimestamp) return false
          if (filter.toTimestamp && tx.timestamp > filter.toTimestamp) return false
          return true
        })
        .slice(filter?.offset || 0, (filter?.offset || 0) + (filter?.limit || 100))
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to list transactions')
    }
  }

  async getTransaction(txId: string, assetId?: string): Promise<UnifiedTransaction> {
    if (!assetId) {
      throw new ProtocolError('Asset ID is required to look up an RGB transaction', 'RGB_LN', 'ASSET_ID_REQUIRED')
    }
    const transactions = await this.listTransactions({ asset: assetId })
    const tx = transactions.find(t => t.id === txId)
    if (!tx) {
      throw new ProtocolError(`Transaction not found: ${txId}`, 'RGB_LN', 'TX_NOT_FOUND')
    }
    return tx
  }

  // ========================================================================
  // Payment Operations
  // ========================================================================

  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }

    try {
      const client = kaleidoClientManager.getClient()

      const lnInvoiceParams: LNInvoiceRequest = {
        expiry_sec: request.expirySeconds || 3600,
      }

      const isRgbInvoice = request.asset && request.asset !== 'BTC' && request.asset !== 'btc'

      if (isRgbInvoice) {
        lnInvoiceParams.asset_id = request.asset
        if (request.assetAmount && request.assetAmount > 0) {
          lnInvoiceParams.asset_amount = request.assetAmount
        }
        // RGB HTLC requires minimum 3000 sats in msats
        const RGB_HTLC_MIN_MSAT = 3000000
        const requestedMsat = request.amount && request.amount > 0 ? request.amount * 1000 : 0
        lnInvoiceParams.amt_msat = Math.max(requestedMsat, RGB_HTLC_MIN_MSAT)
      } else {
        if (request.amount && request.amount > 0) {
          lnInvoiceParams.amt_msat = request.amount * 1000
        }
      }

      const lnInvoice = await client.rln.createLNInvoice(lnInvoiceParams) as
        CreateLNInvoiceResponse & { payment_hash?: string }

      return {
        invoice: lnInvoice.invoice ?? '',
        paymentHash: lnInvoice.payment_hash ?? '',
        amount: request.amount,
        expiresAt: Date.now() + (request.expirySeconds || 3600) * 1000,
        description: request.description,
      }
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to create invoice')
    }
  }

  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }

    try {
      const client = kaleidoClientManager.getClient()
      const decoded = await client.rln.decodeLNInvoice({ invoice }) as
        DecodeLNInvoiceResponse & { description?: string }

      const amtMsat = decoded.amt_msat
      return {
        paymentHash: decoded.payment_hash ?? '',
        amount: amtMsat != null ? amtMsat / 1000 : undefined,
        amountMsat: amtMsat ?? undefined,
        description: decoded.description,
        expiresAt: decoded.expiry_sec ? Date.now() + decoded.expiry_sec * 1000 : 0,
        destination: decoded.payee_pubkey || '',
        asset_id: decoded.asset_id ?? undefined,
        asset_amount: decoded.asset_amount ?? undefined,
        payment_hash: decoded.payment_hash,
        amount_msat: decoded.amt_msat ?? undefined,
      }
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to decode invoice')
    }
  }

  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }

    try {
      const client = kaleidoClientManager.getClient()
      const sendParams: Record<string, unknown> = { invoice: request.invoice }
      if (request.amount) {
        sendParams.amt_msat = request.amount * 1000
      }

      const result = await (client.rln.sendPayment as (body: Record<string, unknown>) => Promise<unknown>)(sendParams) as
        SendPaymentResponse & { payment_preimage?: string; amount_msat?: number; fee_msat?: number }

      return {
        paymentHash: result.payment_hash ?? '',
        preimage: result.payment_preimage,
        amount: result.amount_msat ? result.amount_msat / 1000 : 0,
        fee: result.fee_msat ? result.fee_msat / 1000 : 0,
        status: this.mapPaymentStatus(result.status),
        timestamp: Date.now(),
      }
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to send payment')
    }
  }

  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }

    try {
      const client = kaleidoClientManager.getClient()
      const response = await client.rln.getPayment({ payment_hash: paymentHash }) as Record<string, unknown>
      const payment = (response.payment ?? response) as {
        status?: string; amount_msat?: number; fee_msat?: number; created_at?: number
      }

      return {
        paymentHash,
        status: this.mapPaymentStatus(payment.status),
        amount: payment.amount_msat ? payment.amount_msat / 1000 : undefined,
        fee: payment.fee_msat ? payment.fee_msat / 1000 : undefined,
        timestamp: payment.created_at,
      }
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to get payment status')
    }
  }

  // ========================================================================
  // Address Operations
  // ========================================================================

  async getReceiveAddress(assetId?: string): Promise<Address> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }

    try {
      const client = kaleidoClientManager.getClient()
      const addressData = await client.rln.getAddress() as { address?: string }

      return {
        address: addressData.address ?? '',
        format: 'BTC_ADDRESS',
        asset: assetId,
      }
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to get receive address')
    }
  }

  // ========================================================================
  // Node & Balance Operations
  // ========================================================================

  async getNodeInfo(): Promise<any> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }
    try {
      return await kaleidoClientManager.getClient().rln.getNodeInfo()
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to get node info')
    }
  }

  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }
    try {
      const client = kaleidoClientManager.getClient()
      const btcBalance = await client.rln.getBtcBalance()
      const vanilla = (btcBalance as any)?.vanilla || {}
      const colored = (btcBalance as any)?.colored || {}

      const confirmed = (vanilla.spendable || 0) + (colored.spendable || 0)
      const futureTotal = (vanilla.future || 0) + (colored.future || 0)
      const unconfirmed = Math.max(futureTotal - confirmed, 0)

      return { confirmed, unconfirmed, total: futureTotal }
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to get BTC balance')
    }
  }

  async listChannels(): Promise<any[]> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }
    try {
      const response = await kaleidoClientManager.getClient().rln.listChannels()
      return (response as any)?.channels || response || []
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to list channels')
    }
  }

  async listPayments(): Promise<any> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }
    try {
      return await kaleidoClientManager.getClient().rln.listPayments()
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to list payments')
    }
  }

  async listTransfers(options?: { asset_id?: string }): Promise<any> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }
    try {
      if (!options?.asset_id) {
        return { transfers: [] } as ListTransfersResponse
      }
      return await kaleidoClientManager.getClient().rln.listTransfers({ asset_id: options.asset_id })
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to list transfers')
    }
  }

  // ========================================================================
  // RGB-Specific Operations
  // ========================================================================

  async createRgbInvoice(params: any): Promise<any> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }
    try {
      const durationSec = params.durationSeconds || params.duration_seconds || 3600
      return await kaleidoClientManager.getClient().rln.createRgbInvoice({
        asset_id: params.assetId || params.asset_id,
        expiration_timestamp: Math.floor(Date.now() / 1000) + durationSec,
        min_confirmations: params.minConfirmations || params.min_confirmations || 1,
        witness: params.witness ?? true,
        ...(params.assignment ? { assignment: params.assignment } : {}),
      })
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to create RGB invoice')
    }
  }

  async decodeRgbInvoice(params: any): Promise<any> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }
    try {
      return await kaleidoClientManager.getClient().rln.decodeRgbInvoice({
        invoice: params.invoice || params,
      })
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to decode RGB invoice')
    }
  }

  async getInvoiceStatus(params: { invoice: string }): Promise<any> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }
    try {
      return await kaleidoClientManager.getClient().rln.getInvoiceStatus(params)
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to get invoice status')
    }
  }

  async sendAsset(params: any): Promise<any> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }
    try {
      const client = kaleidoClientManager.getClient()
      const assetId = params.assetId || params.asset_id
      const amount = params.amount ?? params.assignment?.value
      const assignment = params.assignment ?? (amount != null ? { type: 'Fungible', value: amount } : undefined)

      return await client.rln.sendRgb({
        donation: params.donation || false,
        fee_rate: params.feeRate || params.fee_rate || 5,
        min_confirmations: 1,
        recipient_map: {
          [assetId]: [{
            recipient_id: params.recipientId || params.recipient_id,
            assignment,
            transport_endpoints: params.transportEndpoints || params.transport_endpoints || [],
            ...(params.witness_data ? { witness_data: params.witness_data } : {}),
          }],
        },
        // skip_sync is a valid runtime param; cast bridges kaleido-sdk type drift.
        skip_sync: false,
      } as any)
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to send RGB asset')
    }
  }

  async sendBtcOnchain(params: { address: string; amount: number; feeRate?: number }): Promise<any> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }
    try {
      return await kaleidoClientManager.getClient().rln.sendBtc({
        address: params.address,
        amount: params.amount,
        fee_rate: params.feeRate || 5,
        skip_sync: false,
      })
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to send BTC on-chain')
    }
  }

  // ========================================================================
  // Swap Operations (via KaleidoSwap Maker API)
  // ========================================================================

  supportsSwaps(): boolean {
    return true
  }

  async getSwapQuote(request: QuoteRequest): Promise<Quote> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'RGB_LN', 'NOT_CONNECTED')
    }
    if (!this.config?.makerUrl) {
      throw new ProtocolError('Maker API not configured. Swaps not available in node-only mode.', 'RGB_LN', 'MAKER_NOT_CONFIGURED')
    }

    try {
      const client = kaleidoClientManager.getClient()
      const quoteResponse = await client.maker.getQuote({
        from_asset: {
          asset_id: request.fromAsset,
          layer: SdkLayer.RGB_LN,
          amount: request.fromAmount,
        },
        to_asset: {
          asset_id: request.toAsset,
          layer: SdkLayer.RGB_LN,
          amount: request.toAmount,
        },
      }) as unknown as {
        rfq_id: string
        from_asset: { asset_id: string; amount?: string | number }
        to_asset: { asset_id: string; amount?: string | number }
        price: number
        fee: { final_fee: number; fee_asset: string; base_fee: number; variable_fee: number }
        expires_at: number
      }

      return {
        id: quoteResponse.rfq_id,
        fromAsset: quoteResponse.from_asset.asset_id,
        fromAmount: Number(quoteResponse.from_asset.amount || 0),
        toAsset: quoteResponse.to_asset.asset_id,
        toAmount: Number(quoteResponse.to_asset.amount || 0),
        price: quoteResponse.price,
        fee: {
          amount: quoteResponse.fee.final_fee,
          asset: quoteResponse.fee.fee_asset,
          breakdown: {
            baseFee: quoteResponse.fee.base_fee,
            variableFee: quoteResponse.fee.variable_fee,
            networkFee: 0,
          },
        },
        expiresAt: quoteResponse.expires_at,
        provider: 'Kaleidoswap',
      }
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Maker API connection failed')
    }
  }

  async executeSwap(quote: Quote): Promise<SwapResult> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'RGB_LN', 'NOT_CONNECTED')
    }
    if (!this.config?.makerUrl) {
      throw new ProtocolError('Maker API not configured.', 'RGB_LN', 'MAKER_NOT_CONFIGURED')
    }

    try {
      const client = kaleidoClientManager.getClient()
      const quoteAny = quote as Quote & { rfqId?: string; fromLayer?: string; toLayer?: string; receiverAddress?: string }

      const orderRequest = {
        rfq_id: quoteAny.rfqId || quote.id || '',
        from_asset: { asset_id: quote.fromAsset, amount: quote.fromAmount, layer: quoteAny.fromLayer || 'RGB_LN' },
        to_asset: { asset_id: quote.toAsset, amount: quote.toAmount, layer: quoteAny.toLayer || 'RGB_LN' },
        receiver_address: { address: quoteAny.receiverAddress || '', format: 'BTC_ADDRESS' as const },
        min_onchain_conf: 1,
        refund_address: '',
        email: '',
      } as CreateSwapOrderRequest

      const result = await client.maker.createSwapOrder(orderRequest)
      const swapResult = result as CreateSwapOrderResponse & Record<string, unknown> & { payment_hash?: string }
      const swapId = (swapResult.order_id ?? swapResult.id ?? '') as string

      if (swapId && swapResult.access_token) {
        this.swapAccessTokens.set(swapId, swapResult.access_token)
      }

      return {
        swapId,
        paymentHash: (swapResult.payment_hash ?? '') as string,
        status: this.mapSwapStatus(swapResult.status as string | undefined),
        quote,
        timestamp: Date.now(),
      }
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to execute swap')
    }
  }

  async getSwapStatus(swapId: string): Promise<SwapResult> {
    if (!this.isConnected()) {
      throw new ProtocolError('Not connected', 'RGB_LN', 'NOT_CONNECTED')
    }

    try {
      const client = kaleidoClientManager.getClient()
      const accessToken = this.swapAccessTokens.get(swapId)
      if (!accessToken) {
        throw new ProtocolError('Missing swap access token for status lookup', 'RGB_LN', 'SWAP_ACCESS_TOKEN_MISSING')
      }

      const status = await client.maker.getSwapOrderStatus({
        order_id: swapId,
        access_token: accessToken,
      }) as SwapOrderStatusResponse & Record<string, unknown>
      const order = (status.order ?? status) as { status?: string; created_at?: number }

      return {
        swapId,
        status: this.mapSwapStatus(order.status),
        quote: {} as Quote,
        timestamp: order.created_at || Date.now(),
      }
    } catch (error: unknown) {
      throw this.handleSdkError(error, 'Failed to get swap status')
    }
  }

  // ========================================================================
  // Protocol-Specific Operations (escape hatch)
  // ========================================================================

  async executeProtocolOperation(operation: string, params: any): Promise<any> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    }

    const client = kaleidoClientManager.getClient()

    switch (operation) {
      case 'initNode':
        return client.rln.initWallet(params)
      case 'unlockNode':
        return client.rln.unlockWallet(params)
      case 'lockNode':
        return client.rln.lockWallet()
      case 'createUtxos':
        return client.rln.createUtxos(params)
      case 'issueAssetNIA':
        return client.rln.issueAssetNIA(params)
      case 'issueAssetCFA':
        return client.rln.issueAssetCFA(params)
      case 'estimateFee':
        return client.rln.estimateFee(params)
      case 'failTransfers':
        return client.rln.failTransfers(params)
      case 'refreshTransfers':
        return client.rln.refreshTransfers(params)
      case 'sync':
        return client.rln.syncRgbWallet()
      case 'connectPeer':
        return client.rln.connectPeer(params)
      case 'disconnectPeer':
        return client.rln.disconnectPeer(params)
      case 'listPeers':
        return client.rln.listPeers()
      case 'openChannel':
        return client.rln.openChannel(params)
      case 'closeChannel':
        return client.rln.closeChannel(params)
      case 'getAssetMetadata':
        return client.rln.getAssetMetadata(params)
      case 'getTakerPubkey':
        return client.rln.getTakerPubkey()
      case 'whitelistSwap':
        return client.rln.whitelistSwap(params)
      case 'initSwap':
        return client.maker.initSwap(params)
      case 'confirmSwap':
        return client.maker.executeSwap(params)
      case 'listSwaps':
        return client.rln.listSwaps()
      case 'getSwap':
        return client.rln.getSwap(params)
      case 'getLspInfo':
        return client.maker.getLspInfo()
      case 'createLspOrder':
        return client.maker.createLspOrder(params)
      case 'getLspOrder':
        return client.maker.getLspOrder(params)
      case 'estimateLspFees':
        return client.maker.estimateLspFees(params)
      default:
        throw new ProtocolError(`Unknown operation: ${operation}`, 'RGB_LN', 'UNKNOWN_OPERATION')
    }
  }

  // ========================================================================
  // Private Helpers
  // ========================================================================

  private createBtcAsset(btcBalance: BtcBalanceResponse): UnifiedAsset {
    const balance = this.convertBtcBalance(btcBalance)
    return {
      id: 'BTC',
      name: 'Bitcoin (RGB Node)',
      ticker: 'BTC',
      precision: 8,
      protocol: 'RGB_LN',
      layer: 'BTC_L1',
      balance,
      capabilities: {
        canSend: true, canReceive: true, canSwap: true,
        supportsLightning: true, supportsOnchain: true,
      },
    }
  }

  private convertNodeAssetToUnified(asset: Record<string, unknown>): UnifiedAsset {
    return {
      id: asset.asset_id as string,
      name: asset.name as string,
      ticker: asset.ticker as string,
      precision: (asset.precision as number) || 8,
      protocol: 'RGB_LN',
      layer: 'RGB_LN',
      balance: this.convertNodeBalance(asset.balance as Record<string, number> | undefined),
      capabilities: {
        canSend: true, canReceive: true, canSwap: false,
        supportsLightning: true, supportsOnchain: true,
      },
    }
  }

  private convertBtcBalance(btcBalance: BtcBalanceResponse): UnifiedAsset['balance'] {
    const vanilla = (btcBalance as any).vanilla ?? { settled: 0, future: 0, spendable: 0 }
    return {
      total: vanilla.settled || 0,
      available: vanilla.spendable || 0,
      pending: vanilla.future || 0,
      totalDisplay: this.formatAmount(vanilla.settled || 0, 8),
      availableDisplay: this.formatAmount(vanilla.spendable || 0, 8),
    }
  }

  private convertSdkBalance(balance: AssetBalanceResponse): UnifiedAsset['balance'] {
    return {
      total: balance.settled || 0,
      available: balance.spendable || 0,
      pending: balance.future || 0,
      locked: balance.offchain_outbound || 0,
      totalDisplay: this.formatAmount(balance.settled || 0, 8),
      availableDisplay: this.formatAmount(balance.spendable || 0, 8),
    }
  }

  private convertNodeBalance(balance: Record<string, number> | undefined): UnifiedAsset['balance'] {
    const total = balance?.settled || 0
    const available = balance?.spendable || 0
    const pending = balance?.future || 0
    return {
      total, available, pending,
      locked: balance?.offchain_outbound || 0,
      totalDisplay: this.formatAmount(total, 8),
      availableDisplay: this.formatAmount(available, 8),
    }
  }

  private convertTransferToTransaction(transfer: Record<string, unknown>): UnifiedTransaction {
    return {
      id: (transfer.txid as string) || `tx_${Date.now()}`,
      type: this.mapTransferType(transfer.kind as string | undefined),
      status: this.mapTransferStatus(transfer.status as string | undefined),
      timestamp: (transfer.created_at as number) || Date.now(),
      amount: (transfer.amount as number) || 0,
      amountDisplay: this.formatAmount((transfer.amount as number) || 0, 8),
      fee: transfer.fee as number | undefined,
      feeDisplay: this.formatAmount((transfer.fee as number) || 0, 8),
      asset: {} as UnifiedAsset,
      from: transfer.sender as string | undefined,
      to: transfer.recipient as string | undefined,
      protocolData: transfer,
    }
  }

  private mapTransferType(kind?: string): TransactionType {
    if (!kind) return 'send'
    if (kind.includes('receive') || kind.includes('ReceiveAsset')) return 'receive'
    if (kind.includes('send') || kind.includes('SendAsset')) return 'send'
    return 'send'
  }

  private mapTransferStatus(status?: string): TransactionStatus {
    if (!status) return 'pending'
    if (status === 'Settled' || status === 'settled') return 'confirmed'
    if (status === 'Failed' || status === 'failed') return 'failed'
    return 'pending'
  }

  private mapPaymentStatus(status?: string): TransactionStatus {
    if (!status) return 'pending'
    if (status === 'succeeded' || status === 'success' || status === 'Succeeded') return 'confirmed'
    if (status === 'failed' || status === 'Failed') return 'failed'
    return 'pending'
  }

  private mapSwapStatus(status?: string): TransactionStatus {
    if (!status) return 'pending'
    if (status === 'completed' || status === 'success' || status === 'Completed') return 'confirmed'
    if (status === 'failed' || status === 'error' || status === 'Failed') return 'failed'
    return 'pending'
  }

  private formatAmount(amount: number, precision: number): string {
    return (amount / Math.pow(10, precision)).toFixed(precision)
  }

  // ========================================================================
  // Error Handling
  // ========================================================================

  private handleSdkError(error: unknown, context: string): never {
    if (error instanceof NodeNotConfiguredError) {
      throw new ProtocolError('Node not configured', 'RGB_LN', 'NODE_NOT_CONFIGURED')
    } else if (error instanceof QuoteExpiredError) {
      throw new ProtocolError('Quote expired', 'RGB_LN', 'QUOTE_EXPIRED')
    } else if (error instanceof SdkInsufficientBalanceError) {
      throw new InsufficientBalanceError('Insufficient balance', 'RGB_LN', 0, 0)
    } else if (error instanceof APIError) {
      throw new ProtocolError(`${context}: ${error.message}`, 'RGB_LN', 'API_ERROR', error)
    } else if (error instanceof NetworkError) {
      throw new ConnectionError(`${context}: Network error - ${error.message}`, 'RGB_LN', error)
    } else if (error instanceof KaleidoError) {
      throw new ProtocolError(`${context}: ${error.message}`, 'RGB_LN', 'SDK_ERROR', error)
    }

    const msg = error instanceof Error ? error.message : 'Unknown error'
    throw new ProtocolError(`${context}: ${msg}`, 'RGB_LN', 'UNKNOWN_ERROR', error instanceof Error ? error : undefined)
  }
}
