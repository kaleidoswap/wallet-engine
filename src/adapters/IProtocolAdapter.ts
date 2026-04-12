/**
 * Protocol Adapter Interface
 * All protocol implementations must implement this interface
 * Ported from rate-extension/src/protocols/adapters/IProtocolAdapter.ts
 */

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
} from '../types/base'

export interface BaseProtocolConfig {
  protocol: ProtocolType
  network?: 'mainnet' | 'testnet' | 'regtest' | 'signet'
}

export interface IProtocolAdapter {
  readonly protocolName: ProtocolType
  readonly supportedLayers: Layer[]
  readonly version: string

  // Connection Management
  connect(config: BaseProtocolConfig): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  getConnectionInfo(): Promise<ConnectionInfo>

  // Asset Operations
  listAssets(): Promise<UnifiedAsset[]>
  getAsset(assetId: string): Promise<UnifiedAsset>
  getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']>
  refreshBalances(): Promise<void>

  // Transaction Operations
  listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]>
  getTransaction(txId: string, assetId?: string): Promise<UnifiedTransaction>

  // Payment Operations
  createInvoice(request: InvoiceRequest): Promise<Invoice>
  decodeInvoice(invoice: string): Promise<DecodedInvoice>
  sendPayment(request: PaymentRequest): Promise<PaymentResult>
  getPaymentStatus(paymentHash: string): Promise<PaymentStatus>

  // Address Operations
  getReceiveAddress(assetId?: string): Promise<Address>

  // Node & Balance Operations
  getNodeInfo(): Promise<any>
  getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }>
  listChannels(): Promise<any[]>
  listPayments(): Promise<any>
  listTransfers(options?: { asset_id?: string }): Promise<any>

  // Protocol-Specific (Optional)
  createRgbInvoice?(params: any): Promise<any>
  decodeRgbInvoice?(params: any): Promise<any>
  getInvoiceStatus?(params: { invoice: string }): Promise<any>
  sendAsset?(params: any): Promise<any>
  sendBtcOnchain?(params: { address: string; amount: number; feeRate?: number }): Promise<any>

  // Swap Operations (Optional)
  supportsSwaps(): boolean
  getSwapQuote?(request: QuoteRequest): Promise<Quote>
  executeSwap?(quote: Quote): Promise<SwapResult>
  getSwapStatus?(swapId: string): Promise<SwapResult>

  // Generic Extension
  executeProtocolOperation?(operation: string, params: any): Promise<any>
}

export interface IProtocolAdapterFactory {
  createAdapter(protocol: ProtocolType): IProtocolAdapter
  getSupportedProtocols(): ProtocolType[]
}

export class ProtocolAdapterRegistry {
  private adapters: Map<ProtocolType, IProtocolAdapter> = new Map()

  register(adapter: IProtocolAdapter): void {
    this.adapters.set(adapter.protocolName, adapter)
  }

  unregister(protocol: ProtocolType): void {
    this.adapters.delete(protocol)
  }

  get(protocol: ProtocolType): IProtocolAdapter | undefined {
    return this.adapters.get(protocol)
  }

  getAll(): IProtocolAdapter[] {
    return Array.from(this.adapters.values())
  }

  has(protocol: ProtocolType): boolean {
    return this.adapters.has(protocol)
  }

  getSupportedProtocols(): ProtocolType[] {
    return Array.from(this.adapters.keys())
  }
}
