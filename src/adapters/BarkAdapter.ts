/**
 * Bark Protocol Adapter — Second's Ark implementation via `@secondts/bark`.
 *
 * BTC only: no assets, no channels, no native swaps. Lightning send and
 * receive run through the Ark server's gateway, so this adapter needs no
 * Boltz/maker corridor to reach Lightning.
 */

import { IProtocolAdapter, type ProtocolConfig } from './IProtocolAdapter'
import { barkClientManager } from '../lib/bark-client-manager'
import { decodeBolt11Invoice } from '../lib/bolt11'
import { applyTransactionFilter } from '../lib/transaction-filter'
import { PROTOCOL_OPERATIONS } from '../capabilities/operations'
import { log } from '../lib/log'
import type { BarkConfig } from '../types/bark'
import {
  ProtocolType,
  Layer,
  NodeInfo,
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
  TransactionStatus,
  ProtocolError,
  ConnectionError,
  CapabilityError,
  ValidationError,
} from '../types/base'

type BarkWallet = ReturnType<typeof barkClientManager.getWallet>
type Movement = Awaited<ReturnType<BarkWallet['history']>>[number]

const SATS_PRECISION = 8

function isLightningInvoice(value: string): boolean {
  const body = value.trim().toLowerCase().replace(/^lightning:/, '')
  return /^ln(bc|tb|bcrt|sb)/.test(body)
}

/**
 * Ask the bindings, never the prefix: Arkade mints `tark1…` too, and sending
 * one of its addresses to this Ark's server would be a loss, not an error.
 */
function isBarkAddress(value: string): boolean {
  return barkClientManager.isBarkAddress(value)
}

function formatSats(sats: number): string {
  return (sats / 1e8).toFixed(SATS_PRECISION)
}

/** Movement timestamps are RFC3339 strings, not unix seconds. */
function movementTimestamp(movement: Movement): number {
  const parsed = Date.parse(movement.completedAt ?? movement.createdAt)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

function movementStatus(movement: Movement): TransactionStatus {
  switch (movement.status?.toLowerCase()) {
    case 'completed':
    case 'settled':
      return 'confirmed'
    case 'failed':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    default:
      return movement.completedAt ? 'confirmed' : 'pending'
  }
}

export class BarkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'BARK'
  readonly supportedLayers: Layer[] = ['BTC_BARK', 'BTC_L1', 'BTC_LN']
  readonly version = '1.0.0'
  readonly capabilities = PROTOCOL_OPERATIONS.BARK

  private config: BarkConfig | null = null

  // ==========================================================================
  // Connection
  // ==========================================================================

  async connect(config: ProtocolConfig): Promise<void> {
    const barkConfig = config as unknown as BarkConfig
    if (!barkConfig.mnemonic) {
      throw new ConnectionError('Wallet recovery secret is required for a bark wallet', 'BARK')
    }
    if (!barkConfig.arkServerUrl) {
      throw new ConnectionError('arkServerUrl is required for a bark wallet', 'BARK')
    }
    try {
      await barkClientManager.initialize(barkConfig)
      this.config = barkConfig
      log.info('[BarkAdapter] Connected')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ConnectionError(`Failed to connect bark wallet: ${message}`, 'BARK', error)
    }
  }

  async disconnect(): Promise<void> {
    await barkClientManager.dispose()
    this.config = null
  }

  isConnected(): boolean {
    return barkClientManager.isInitialized()
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    if (!this.isConnected()) {
      return { protocol: 'BARK', connected: false }
    }
    const wallet = this.wallet()
    const [info, properties] = await Promise.all([wallet.arkInfo(), wallet.properties()])
    const degraded: string[] = []
    // An unreachable server still opens the wallet from IndexedDB; every
    // off-chain operation then fails one call at a time.
    if (!info) degraded.push('ark-server-unreachable')
    return {
      protocol: 'BARK',
      connected: true,
      nodeId: info?.serverPubkey,
      network: properties.network,
      syncStatus: { synced: true },
      degraded: degraded.length > 0 ? degraded : undefined,
    }
  }

  // ==========================================================================
  // Assets and balances
  // ==========================================================================

  async listAssets(): Promise<UnifiedAsset[]> {
    const balance = await this.wallet().balance()
    const available = balance.spendableSats
    const total =
      balance.spendableSats +
      balance.pendingInRoundSats +
      balance.pendingBoardSats +
      balance.claimableLightningReceiveSats

    return [
      {
        id: 'BTC',
        name: 'Bitcoin',
        ticker: 'BTC',
        precision: SATS_PRECISION,
        protocol: 'BARK',
        layer: 'BTC_BARK',
        balance: {
          total,
          available,
          // A VTXO in a round is unspendable until the round settles, which is
          // up to one round interval (5 minutes on Second's servers) away.
          pending: total - available,
          locked: balance.pendingExitSats + balance.pendingLightningSendSats,
          totalDisplay: formatSats(total),
          availableDisplay: formatSats(available),
        },
        capabilities: {
          canSend: true,
          canReceive: true,
          canSwap: false,
          supportsLightning: true,
          supportsOnchain: true,
        },
        metadata: { barkBalance: balance },
      },
    ]
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets()
    const asset = assets.find((candidate) => candidate.id === assetId)
    if (!asset) throw new ProtocolError(`Unknown bark asset: ${assetId}`, 'BARK')
    return asset
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    return (await this.getAsset(assetId)).balance
  }

  async refreshBalances(): Promise<void> {
    await this.wallet().sync()
  }

  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    const balance = await this.wallet().balance()
    const unconfirmed = balance.pendingInRoundSats + balance.pendingBoardSats
    return {
      confirmed: balance.spendableSats,
      unconfirmed,
      total: balance.spendableSats + unconfirmed,
    }
  }

  // ==========================================================================
  // History
  // ==========================================================================

  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    const [movements, asset] = await Promise.all([this.wallet().history(), this.getAsset('BTC')])
    const txs = movements.map((movement) => this.toUnifiedTransaction(movement, asset))
    return applyTransactionFilter(txs, filter)
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    const txs = await this.listTransactions()
    const tx = txs.find((candidate) => candidate.id === txId)
    if (!tx) throw new ProtocolError(`Bark movement not found: ${txId}`, 'BARK')
    return tx
  }

  private toUnifiedTransaction(movement: Movement, asset: UnifiedAsset): UnifiedTransaction {
    const amount = movement.effectiveBalanceSats
    return {
      id: String(movement.id),
      type: amount >= 0 ? 'receive' : 'send',
      status: movementStatus(movement),
      timestamp: movementTimestamp(movement),
      amount: Math.abs(amount),
      amountDisplay: formatSats(Math.abs(amount)),
      fee: movement.offchainFeeSats,
      feeDisplay: formatSats(movement.offchainFeeSats),
      asset,
      from: movement.receivedOnAddresses[0],
      to: movement.sentToAddresses[0],
      protocolData: {
        subsystem: movement.subsystemName,
        subsystemKind: movement.subsystemKind,
        paymentHash: movement.paymentHash,
        lightningInvoice: movement.lightningInvoice,
        inputVtxoIds: movement.inputVtxoIds,
        outputVtxoIds: movement.outputVtxoIds,
      },
    }
  }

  async listPayments(): Promise<unknown> {
    return this.wallet().history()
  }

  async listTransfers(): Promise<unknown> {
    return this.wallet().history()
  }

  async listChannels(): Promise<unknown[]> {
    return []
  }

  // ==========================================================================
  // Receive
  // ==========================================================================

  async getReceiveAddress(): Promise<Address> {
    const address = await this.wallet().newAddress()
    return {
      address,
      // Bark and Arkade both mint `tark1…`; the format says how to render it,
      // never which Ark it belongs to.
      format: 'ARKADE_ADDRESS',
      asset: 'BTC',
    }
  }

  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    if (!request.amount || request.amount <= 0) {
      throw new ValidationError('Bark Lightning invoices require an amount in sats', 'BARK')
    }
    const invoice = await this.wallet().bolt11Invoice({ amountSats: request.amount })
    const decoded = decodeBolt11Invoice(invoice.invoice)
    return {
      invoice: invoice.invoice,
      paymentHash: invoice.paymentHash,
      amount: invoice.amountSats,
      expiresAt: decoded.expiresAtUnixSeconds * 1000,
      description: request.description,
    }
  }

  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    const decoded = decodeBolt11Invoice(invoice)
    const amountSat = decoded.amountSat ? Number(decoded.amountSat) : undefined
    return {
      paymentHash: decoded.paymentHash,
      amount: amountSat,
      amountMsat: decoded.amountMsat ? Number(decoded.amountMsat) : undefined,
      expiresAt: decoded.expiresAtUnixSeconds * 1000,
      destination: '',
      payment_hash: decoded.paymentHash,
      expires_at: decoded.expiresAtUnixSeconds * 1000,
    }
  }

  // ==========================================================================
  // Send
  // ==========================================================================

  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    const target = request.invoice?.trim()
    if (!target) throw new ValidationError('A destination is required', 'BARK')

    if (isLightningInvoice(target)) return this.payLightning(target, request.amount)
    if (isBarkAddress(target)) return this.payArkoor(target, request.amount)
    throw new ValidationError(
      'Unsupported bark destination: expected a bolt11 invoice or a bark ark address',
      'BARK',
    )
  }

  private async payLightning(invoice: string, amount?: number): Promise<PaymentResult> {
    const stripped = invoice.replace(/^lightning:/i, '')
    const status = await this.wallet().payLightningInvoice({
      invoice: stripped,
      amountSats: amount,
      wait: true,
    })
    const decoded = decodeBolt11Invoice(stripped)
    const paid = status.type === 'paid'
    return {
      // wasm-bindgen leaks the Rust field name on this variant: `payment_hash`,
      // not `paymentHash`.
      paymentHash: paid ? status.payment_hash : decoded.paymentHash,
      preimage: paid ? status.preimage : undefined,
      amount: amount ?? (decoded.amountSat ? Number(decoded.amountSat) : 0),
      fee: 0,
      status: paid ? 'confirmed' : status.type === 'inProgress' ? 'pending' : 'unknown',
      timestamp: Date.now(),
    }
  }

  private async payArkoor(address: string, amount?: number): Promise<PaymentResult> {
    if (!amount || amount <= 0) {
      throw new ValidationError('An ark payment requires an amount in sats', 'BARK')
    }
    await this.wallet().sendArkoorPayment(address, amount)
    return {
      paymentHash: '',
      amount,
      fee: 0,
      status: 'confirmed',
      timestamp: Date.now(),
    }
  }

  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    const wallet = this.wallet()
    try {
      const send = await wallet.lightningSendState(paymentHash)
      if (send.type === 'paid') {
        return { paymentHash, status: 'confirmed', timestamp: Date.now() }
      }
      if (send.type === 'inProgress') {
        return { paymentHash, status: 'pending', timestamp: Date.now() }
      }
    } catch {
      // Not a send this wallet knows about — fall through to the receive side.
    }
    try {
      const receive = await wallet.lightningReceiveState(paymentHash)
      return {
        paymentHash,
        status: receive.state === 'settled' ? 'confirmed' : 'pending',
        amount: receive.amountSats,
        timestamp: receive.settledAt ? receive.settledAt * 1000 : Date.now(),
      }
    } catch (error) {
      return {
        paymentHash,
        status: 'unknown',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // ==========================================================================
  // On-chain (IOnchainOperations)
  // ==========================================================================

  async sendBtcOnchain(params: { address: string; amount: number }): Promise<unknown> {
    if (!params.amount || params.amount <= 0) {
      throw new ValidationError('An on-chain send requires an amount in sats', 'BARK')
    }
    const txid = await this.wallet().sendOnchain(params.address, params.amount)
    return { txid }
  }

  async broadcastTransaction(txHex: string): Promise<{ txid: string }> {
    return { txid: await this.wallet().broadcastTx(txHex) }
  }

  // ==========================================================================
  // Node info / swaps
  // ==========================================================================

  async getNodeInfo(): Promise<NodeInfo> {
    const wallet = this.wallet()
    const [info, balance] = await Promise.all([wallet.arkInfo(), wallet.balance()])
    return {
      pubkey: info?.serverPubkey,
      local_balance_sat: balance.spendableSats,
      num_channels: 0,
      roundIntervalSecs: info?.roundIntervalSecs,
      vtxoLifetimeBlocks: info?.vtxoLifetime,
      minBoardAmountSats: info?.minBoardAmountSats,
    }
  }

  supportsSwaps(): boolean {
    return false
  }

  async getQuote(_request: QuoteRequest): Promise<Quote> {
    throw new CapabilityError('Bark has no native swaps', 'BARK')
  }

  async executeSwap(_quote: Quote): Promise<SwapResult> {
    throw new CapabilityError('Bark has no native swaps', 'BARK')
  }

  private wallet(): BarkWallet {
    if (!this.isConnected()) {
      throw new ConnectionError('Bark wallet is not connected', 'BARK')
    }
    return barkClientManager.getWallet()
  }
}
