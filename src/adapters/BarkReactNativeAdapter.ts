import { BaseBarkAdapter } from './BaseBarkAdapter.js'
import { BarkReactNativeBackend } from '../backends/BarkReactNativeBackend.js'
import { positiveSats } from '../backends/bark-convert.js'
import { decodeBolt11Invoice, validateBolt11Invoice } from '../lib/bolt11.js'
import { preimageMatchesPaymentHash } from '../lightning/preimages.js'
import { getPlatform, type IRuntimeProvider } from '../ports/index.js'
import type { BarkClient } from '../lib/bark-client.js'
import type { BarkConfig } from '../types/bark.js'
import type { Invoice, InvoiceRequest, PaymentRequest, PaymentResult, PaymentStatus } from '../types/base.js'
import { CapabilityError, ConfigurationError, ValidationError } from '../types/base.js'

/** Bark protocol adapter backed by the on-device UniFFI SDK and SQLite. */
export class BarkReactNativeAdapter extends BaseBarkAdapter {
  readonly backend: BarkReactNativeBackend
  private readonly runtime: Pick<IRuntimeProvider, 'now'>

  constructor(options: { runtime?: Pick<IRuntimeProvider, 'now'> } = {}) {
    const runtime = options.runtime ?? getPlatform()?.runtime
    if (!runtime) throw new ConfigurationError('Inject a runtime or call setPlatform before creating BarkReactNativeAdapter', 'BARK')
    const backend = new BarkReactNativeBackend()
    const client: BarkClient = {
      initialize: async (config: BarkConfig) => {
        if (!config.dataDir || !config.network) throw new ConfigurationError('Bark React Native requires dataDir and an explicit network', 'BARK')
        if (config.runDaemon || config.skipRecovery || config.dbName) {
          throw new ConfigurationError('Native Bark uses manual sync, recovery, and dataDir; browser storage/daemon overrides are unsupported', 'BARK')
        }
        await backend.connect({
          network: config.network, mnemonic: config.mnemonic, dataDir: config.dataDir,
          serverUrl: config.arkServerUrl, esploraUrl: config.esploraUrl ?? '',
          createIfMissing: config.createIfMissing, onchain: true,
          vtxoRefreshExpiryThreshold: config.vtxoRefreshExpiryThreshold, userAgent: config.userAgent,
        })
      },
      dispose: () => backend.disconnect(),
      isInitialized: () => backend.isConnected(),
      isBarkAddress: address => backend.isBarkAddress(address),
      getWallet: () => backend.getWalletPort(),
    }
    super(client)
    this.backend = backend
    this.runtime = runtime
  }

  override async getConnectionInfo() {
    const info = await super.getConnectionInfo()
    return { ...info, syncStatus: { synced: this.backend.isSynced() } }
  }

  override async getReceiveAddress(assetId?: string) {
    if (assetId && assetId !== 'BTC') throw new ValidationError('Bark supports BTC only', 'BARK')
    return super.getReceiveAddress()
  }

  override async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    if (request.asset && request.asset !== 'BTC') throw new ValidationError('Bark supports BTC only', 'BARK')
    if (request.assetAmount !== undefined || (request.layer && request.layer !== 'BTC_LN')) {
      throw new CapabilityError('Use getReceiveAddress for an Ark payment or getOnchainAddress for an on-chain deposit', 'BARK')
    }
    if (request.expirySeconds !== undefined) throw new CapabilityError('Bark does not expose a custom invoice expiry', 'BARK')
    positiveSats(request.amount!)
    const invoice = await this.backend.getWalletPort().bolt11Invoice({ amountSats: request.amount!, description: request.description })
    const decoded = decodeBolt11Invoice(invoice.invoice)
    if (decoded.paymentHash !== invoice.paymentHash || Number(decoded.amountSat) !== request.amount) {
      throw new ValidationError('Bark invoice does not match the requested amount', 'BARK')
    }
    return { invoice: invoice.invoice, paymentHash: invoice.paymentHash, amount: invoice.amountSats,
      expiresAt: decoded.expiresAtUnixSeconds * 1000, description: request.description }
  }

  override async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    const target = request.invoice?.trim().replace(/^lightning:/i, '')
    const amountOverride = request.amount
    if (!target) throw new ValidationError('A destination is required', 'BARK')
    if (request.maxFeeSats !== undefined) throw new CapabilityError('Bark cannot enforce a payment fee cap', 'BARK')
    const wallet = this.backend.getWalletPort()
    const timestamp = this.runtime.now()
    if (this.backend.isBarkAddress(target)) {
      positiveSats(amountOverride!)
      await this.backend.sendArkPayment({ address: target, amountSats: amountOverride! })
      return { paymentHash: '', amount: amountOverride!, fee: 0, feeKnown: false, status: 'pending', timestamp }
    }
    const info = await this.backend.getWalletInfo()
    const decoded = validateBolt11Invoice(target, {
      expectedNetworkId: info.network === 'mainnet' ? 'bitcoin' : info.network,
      nowUnixSeconds: Math.floor(timestamp / 1000),
    })
    if (decoded.amountMsat !== undefined && decoded.amountSat === undefined) {
      throw new ValidationError('Bark requires whole-satoshi Lightning amounts', 'BARK')
    }
    const fixedAmount = decoded.amountSat === undefined ? undefined : Number(decoded.amountSat)
    if (fixedAmount !== undefined && amountOverride !== undefined && amountOverride !== fixedAmount) {
      throw new ValidationError('Amount override does not match the invoice', 'BARK')
    }
    const amount = fixedAmount ?? amountOverride
    positiveSats(amount!)
    const result = await wallet.payLightningInvoice({
      invoice: target, amountSats: fixedAmount === undefined ? amount : undefined, wait: false,
    })
    if (result.type === 'inProgress') {
      return { paymentHash: decoded.paymentHash, amount: result.send.amountSats, fee: result.send.feeSats,
        feeKnown: true, status: 'pending', timestamp }
    }
    if (result.type === 'paid' && result.payment_hash === decoded.paymentHash && preimageMatchesPaymentHash(result.preimage, decoded.paymentHash)) {
      // A missing history row must not turn a proven paid invoice into a retry.
      let fee: number | undefined
      try {
        const rows = await this.backend.getHistory()
        const row = rows.find(m => m.paymentHash === decoded.paymentHash && m.effectiveBalanceDeltaSats < 0)
        fee = row?.feeSats
      } catch { /* settlement evidence remains authoritative */ }
      return { paymentHash: decoded.paymentHash, preimage: result.preimage, amount: amount!, fee: fee ?? 0,
        feeKnown: fee !== undefined, status: 'confirmed', timestamp }
    }
    return { paymentHash: decoded.paymentHash, amount: amount!, fee: 0, feeKnown: false, status: 'unknown', timestamp }
  }

  override async getPaymentStatus(hash: string): Promise<PaymentStatus> {
    if (!/^[a-f0-9]{64}$/i.test(hash)) throw new ValidationError('A 32-byte payment hash is required', 'BARK')
    const paymentHash = hash.toLowerCase()
    const wallet = this.backend.getWalletPort()
    try {
      const result = await wallet.lightningSendState(paymentHash)
      if (result.type === 'paid') {
        return { paymentHash, status: result.payment_hash === paymentHash && preimageMatchesPaymentHash(result.preimage, paymentHash) ? 'confirmed' : 'unknown' }
      }
      if (result.type === 'inProgress') return { paymentHash, status: 'pending', amount: result.send.amountSats, fee: result.send.feeSats }
    } catch { /* try the receive ledger without advancing payment state */ }
    try {
      const receive = await wallet.lightningReceiveState(paymentHash)
      return { paymentHash, status: receive.state === 'settled' ? 'confirmed' : 'pending', amount: receive.amountSats,
        timestamp: receive.settledAt === undefined ? undefined : receive.settledAt * 1000 }
    } catch {
      return { paymentHash, status: 'unknown', error: 'Bark payment status is unavailable' }
    }
  }

  override async sendBtcOnchain(params: { address: string; amount: number; feeRate?: number }): Promise<{ txid: string }> {
    if (params.feeRate !== undefined) throw new CapabilityError('Bark off-chain sends do not expose a fee-rate override', 'BARK')
    if (!params.address?.trim()) throw new ValidationError('An on-chain destination is required', 'BARK')
    positiveSats(params.amount)
    return { txid: await this.backend.getWalletPort().sendOnchain(params.address, params.amount) }
  }
}
