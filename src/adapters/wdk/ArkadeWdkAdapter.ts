/**
 * ArkadeWdkAdapter
 * ----------------
 * Wraps the Arkade WDK module (@arkade-os/wdk, over @arkade-os/sdk + boltz-swap)
 * onto the stable `IProtocolAdapter` contract. Arkade is a VTXO-based Bitcoin L2:
 * off-chain Ark transfers, an on-chain "boarding" address for funding, and Lightning
 * receive via Boltz reverse submarine swaps.
 *
 * Discipline: no WDK/@arkade-os types cross the contract — domain types only;
 * module objects are read as `any`. The WDK **account** surface is the primary path;
 * the underlying @arkade-os/sdk Wallet (`account._signingWallet`) is reached only for
 * the VTXO-lifecycle ops the WDK surface does not expose (getVtxos, getBoardingUtxos,
 * onboard, offboard, rich balance summary) — ported from the native ArkadeAdapter.
 * `@arkade-os/sdk` is lazy-loaded in `connect()` so this sub-path stays SDK-free until used.
 *
 * Arkade WDK surface (from JSDoc, v0.1.4):
 *   read-only: getAddress(): string (Ark address, inherited), getBoardingAddress(): string,
 *              getBalance(): bigint, getTokenBalance(id): bigint, getTransactionHistory()
 *   account:   sendTransaction({to,value}), transfer({token,recipient,amount}),
 *              createLightningInvoice(amountSats, description?): {invoice,paymentHash},
 *              waitForLightningPayment(invoice): {txid}, getLightningLimits/Fees,
 *              arkadeSwaps (Boltz client, for Lightning send), subscribeToIncomingFunds, sign, dispose
 */

import { IProtocolAdapter, BaseProtocolConfig } from '../IProtocolAdapter'
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
  TransactionStatus,
  ProtocolError,
} from '../../types/base'
import { getCapabilities } from '../../capabilities'
import { BaseWdkAdapter } from './BaseWdkAdapter'
import { PROTOCOL_OPERATIONS } from '../../capabilities/operations'
import { loadWdkModule } from './moduleLoader'
import { decodeBolt11, isBolt11 } from '../../lib/bolt11'
import { normalizeVtxos, sortVtxosByExpiry, toNumber, formatSats, formatUnits } from '../../lib/arkade-helpers'
import { signLnMessage, verifyLnMessage } from '../../lib/ln-message-sign'
import { resolveWalletSeed } from '../../lib/wallet-seed'

const isBitcoinAddress = (value: string): boolean => /^(bc1|tb1|bcrt1)/i.test(value.trim())
const isLightningInvoice = (value: string): boolean => {
  const body = value.trim().toLowerCase().replace(/^lightning:/, '')
  return /^ln(bc|tb|bcrt|sb)/.test(body)
}

export interface ArkadeAdapterConfig extends BaseProtocolConfig {
  protocol: 'ARKADE'
  /** BIP-39 mnemonic for this wallet. */
  mnemonic: string
  /** BIP-44 account index (default 0). */
  accountIndex?: number
  /** Arkade wallet config (ark server URL, indexer URL, swap provider URL, …) passed through to the module. */
  arkadeConfig?: Record<string, any>
}

/**
 * Allowlist of Arkade account methods reachable via `executeProtocolOperation`.
 * VTXO-lifecycle ops (onboard/offboard/getVtxos/getBoardingUtxos) are now typed
 * adapter methods, so they are intentionally NOT here.
 */
const ARKADE_ALLOWED_OPS: ReadonlySet<string> = new Set([
  'waitForLightningPayment',
  'getLightningLimits',
  'getLightningFees',
  'subscribeToIncomingFunds',
  'getBoardingAddress',
  'getTokenBalance',
  'getTransactionHistory',
])

export class ArkadeWdkAdapter extends BaseWdkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'ARKADE'
  readonly capabilities = PROTOCOL_OPERATIONS.ARKADE
  readonly supportedLayers: Layer[] = getCapabilities('ARKADE').layers


  /** Lazily-loaded `@arkade-os/sdk` (for Ramps onboard/offboard). Kept off the static import graph. */
  private arkSdk: any = null

  /** The underlying @arkade-os/sdk Wallet the WDK account wraps — for VTXO-lifecycle ops. */
  private get rawWallet(): any {
    const w = (this.account as any)?._signingWallet ?? (this.account as any)?._wallet
    if (!w) throw new ProtocolError('Arkade wallet unavailable', 'ARKADE', 'NOT_CONNECTED')
    return w
  }

  // --- Connection ---------------------------------------------------------
  async connect(config: BaseProtocolConfig): Promise<void> {
    const cfg = config as ArkadeAdapterConfig & {
      arkServerUrl?: string
      esploraUrl?: string
      swapProviderUrl?: string
    }
    if (!cfg.mnemonic) throw new ProtocolError('ArkadeWdkAdapter requires a mnemonic', 'ARKADE', 'CONFIG')
    this.mnemonic = cfg.mnemonic
    this.network = cfg.network ?? 'mainnet'
    // Accept either an explicit `arkadeConfig` passthrough OR the native adapter's
    // flat fields (arkServerUrl/esploraUrl/swapProviderUrl) — so hosts can switch
    // to this adapter without reshaping their connect config. The WDK manager
    // spreads this straight into @arkade-os/sdk's Wallet.create.
    const arkadeConfig =
      cfg.arkadeConfig ??
      ({
        ...(cfg.arkServerUrl ? { arkServerUrl: cfg.arkServerUrl } : {}),
        ...(cfg.esploraUrl ? { esploraUrl: cfg.esploraUrl } : {}),
        ...(cfg.swapProviderUrl ? { swapProviderUrl: cfg.swapProviderUrl } : {}),
      } as Record<string, any>)
    // @ts-ignore — external module, resolved at runtime in the consuming app.
    const mod = await loadWdkModule('@arkade-os/wdk', () => import('@arkade-os/wdk'))
    const WalletManagerArkade = mod.default ?? mod.WalletManagerArkade ?? mod
    // Resolve to seed bytes so nsec/hex-rooted wallets bypass the WDK base's
    // BIP-39 string validation (which throws "The seed phrase is invalid").
    this.manager = new WalletManagerArkade(resolveWalletSeed(cfg.mnemonic), arkadeConfig)
    this.account = await this.manager.getAccount(cfg.accountIndex ?? 0)
    // Lazy-load the SDK for Ramps (onboard/offboard). Off the static import graph.
    // @ts-ignore — resolved at runtime; a transitive dep of the WDK Arkade module.
    this.arkSdk = await loadWdkModule('@arkade-os/sdk', () => import('@arkade-os/sdk'))
    this.connected = true
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    this.assertConnected()
    return {
      protocol: 'ARKADE',
      connected: this.connected,
      network: this.network,
      syncStatus: { synced: true, progress: 100 },
    }
  }

  // --- Address / receive --------------------------------------------------
  /** Default Ark address. For the on-chain boarding address use `getBoardingAddress`. */
  async getReceiveAddress(assetId?: string): Promise<Address> {
    this.assertConnected()
    // 'onchain'/'boarding' → on-chain boarding address for funding.
    if (assetId === 'onchain' || assetId === 'boarding') {
      const address: string = await this.account.getBoardingAddress()
      return { address, format: 'BTC_ADDRESS', asset: 'BTC' }
    }
    const address: string = await this.account.getAddress()
    return { address, format: 'ARKADE_ADDRESS', asset: assetId && assetId !== 'BTC' ? assetId : 'BTC' }
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
    const b = await this.getWalletBalanceSummary()
    // preconfirmed VTXOs are spendable, so `confirmed` = settled + preconfirmed.
    const confirmed = b.available
    return { confirmed, unconfirmed: Math.max(b.total - confirmed, 0), total: b.total }
  }

  async refreshBalances(): Promise<void> {
    // Arkade syncs against the indexer on read; no explicit sync call.
  }

  async listAssets(): Promise<UnifiedAsset[]> {
    this.assertConnected()
    const b = await this.getWalletBalanceSummary()
    const btc: UnifiedAsset = {
      id: 'BTC',
      name: 'Bitcoin (Arkade)',
      ticker: 'BTC',
      precision: 8,
      protocol: 'ARKADE',
      layer: 'BTC_ARKADE',
      balance: {
        total: b.total,
        available: b.available,
        pending: 0,
        locked: 0,
        totalDisplay: formatSats(b.total),
        availableDisplay: formatSats(b.available),
      },
      capabilities: { canSend: true, canReceive: true, canSwap: false, supportsLightning: false, supportsOnchain: true },
      metadata: { boarding: b.boardingTotal, settled: b.settled, preconfirmed: b.preconfirmed, recoverable: b.recoverable },
    }
    const out: UnifiedAsset[] = [btc]

    // Arkade tokens. The wallet's `getBalance()` includes `assets: { assetId, amount }[]`;
    // resolve metadata via `assetManager.getAssetDetails(assetId).metadata`.
    try {
      const wallet = this.rawWallet
      const rawBalance: any = wallet?.getBalance ? await wallet.getBalance() : null
      const rawAssets: any[] = Array.isArray(rawBalance?.assets) ? rawBalance.assets : []
      for (const entry of rawAssets) {
        const assetId = String(entry?.assetId ?? '')
        const amount = Number(entry?.amount ?? 0)
        if (!assetId || amount <= 0) continue
        let meta: any = {}
        try {
          meta = (await wallet?.assetManager?.getAssetDetails?.(assetId))?.metadata ?? {}
        } catch {
          /* metadata lookup is optional */
        }
        const decimals = Number(meta.decimals ?? 0) || 0
        const ticker = typeof meta.ticker === 'string' && meta.ticker.trim() ? meta.ticker : assetId.slice(0, 6)
        const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name : ticker
        out.push({
          id: assetId,
          name,
          ticker,
          precision: decimals,
          protocol: 'ARKADE',
          layer: 'ARKADE_ARKADE',
          balance: { total: amount, available: amount, pending: 0, totalDisplay: formatUnits(amount, decimals), availableDisplay: formatUnits(amount, decimals) },
          icon: typeof meta.icon === 'string' ? meta.icon : undefined,
          capabilities: { canSend: true, canReceive: true, canSwap: false, supportsLightning: false, supportsOnchain: false },
        })
      }
    } catch {
      /* token enumeration is best-effort — keep BTC even if unavailable */
    }
    return out
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    this.assertConnected()
    if (assetId === 'BTC' || assetId.toLowerCase() === 'btc') {
      const { balance } = await this.getAsset('BTC').then((a) => ({ balance: a.balance }))
      return balance
    }
    const bal: bigint = await this.account.getTokenBalance(assetId)
    const n = Number(bal)
    const precision = (await this.listAssets()).find((a) => a.id === assetId)?.precision ?? 0
    return { total: n, available: n, pending: 0, totalDisplay: formatUnits(n, precision), availableDisplay: formatUnits(n, precision) }
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets()
    const found = assets.find((a) => a.id === assetId || a.ticker === assetId)
    if (!found) throw new ProtocolError(`Unknown asset ${assetId}`, 'ARKADE', 'NO_ASSET')
    return found
  }

  // --- Invoices -----------------------------------------------------------
  /** Arkade on-chain receive is an address, not a bolt11 invoice (mirrors the native adapter). */
  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    this.assertConnected()
    const address: string = await this.account.getAddress()
    return {
      invoice: address,
      paymentHash: '',
      amount: request.amount,
      expiresAt: Date.now() + (request.expirySeconds ?? 3600) * 1000,
      description: request.description ?? 'Arkade receiving address',
    }
  }

  /**
   * Boltz reverse-swap Lightning invoice that lands funds in this Arkade wallet as a
   * VTXO. Requires amount > 0 (Boltz can't issue an amountless invoice). The embedded
   * SwapManager claims the VHTLC automatically once the LN payment settles.
   */
  async createArkadeLightningInvoice(request: InvoiceRequest): Promise<Invoice> {
    this.assertConnected()
    if (!request.amount || request.amount <= 0) {
      throw new ProtocolError('Amount is required for Boltz Lightning invoices into Arkade', 'ARKADE', 'INVALID_AMOUNT')
    }
    // createLightningInvoice(amountSats, description?) — POSITIONAL args; via Boltz reverse swap.
    const r: any = await this.account.createLightningInvoice(request.amount, request.description)
    return {
      invoice: r?.invoice ?? '',
      paymentHash: r?.paymentHash ?? '',
      amount: request.amount,
      expiresAt: Date.now() + (request.expirySeconds ?? 3600) * 1000,
      description: request.description ?? 'Boltz reverse swap into Arkade',
    }
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

    // Lightning send via Boltz submarine swap (Arkade → Lightning), if the account exposes the swap client.
    if (isLightningInvoice(dest)) {
      const swaps: any = (this.account as any)?.arkadeSwaps
      if (!swaps?.sendLightningPayment) {
        throw new ProtocolError('Arkade Lightning send not available in this module version', 'ARKADE', 'NOT_SUPPORTED')
      }
      const invoiceBody = dest.toLowerCase().startsWith('lightning:') ? dest.slice('lightning:'.length) : dest
      try {
        const result: any = await swaps.sendLightningPayment({ invoice: invoiceBody })
        return {
          paymentHash: result?.preimage ?? result?.txid ?? '',
          amount: Number(result?.amount ?? request.amount ?? 0),
          fee: 0,
          status: 'pending',
          timestamp: Date.now(),
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        if (/less than minimal/i.test(msg)) {
          throw new ProtocolError(
            "Arkade can't pay amountless Lightning invoices. Ask the recipient for an invoice with an amount.",
            'ARKADE',
            'INVALID_AMOUNT',
          )
        }
        throw new ProtocolError(`Failed to send Lightning payment via Boltz: ${msg}`, 'ARKADE', 'SEND_PAYMENT_ERROR')
      }
    }

    if (request.amount == null) {
      throw new ProtocolError('Arkade send requires an explicit amount', 'ARKADE', 'NO_AMOUNT')
    }
    // Bitcoin destination → on-chain offboard. Route through sendBtcOnchain so the
    // missing-tx-id guard and async `pending` status apply regardless of entry point.
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
      // The txid lives on `key` (unused fields are empty strings, so pick the first
      // NON-EMPTY one — `??` would stop at `''`). Direction is the explicit `type`.
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

  // --- Node & balance -----------------------------------------------------
  async getNodeInfo(): Promise<NodeInfo> {
    this.assertConnected()
    const b = await this.getWalletBalanceSummary()
    const spendableSats = b.available
    return {
      channelsBalanceMsat: spendableSats * 1000,
      maxPayableMsat: spendableSats * 1000,
      onchainBalanceMsat: b.boardingConfirmed * 1000,
      pendingOnchainBalanceMsat: b.boardingUnconfirmed * 1000,
      maxReceivableMsat: 0,
      inboundLiquidityMsats: 0,
      connectedPeers: [],
      utxos: 0,
    }
  }

  async listChannels(): Promise<any[]> {
    return [] // Arkade has no LN channels (LN via Boltz swaps)
  }

  async listPayments(): Promise<any> {
    const txs = await this.listTransactions()
    return { payments: txs }
  }

  async listTransfers(): Promise<any> {
    return { transfers: [] }
  }

  // --- VTXO lifecycle -----------------------------------------------------
  /** All VTXOs, sorted by batchExpiry ascending (expiry-first) so soon-to-expire coins surface first. */
  async getVtxos(): Promise<Record<string, unknown>[]> {
    this.assertConnected()
    const vtxos = await this.rawWallet.getVtxos()
    return normalizeVtxos(sortVtxosByExpiry(vtxos)).map((vtxo) => ({
      txid: vtxo.txid,
      vout: vtxo.vout,
      value: vtxo.value,
      state: vtxo.state,
      batchTxid: vtxo.batchTxid,
      batchExpiry: vtxo.batchExpiry,
      createdAt: vtxo.createdAt,
      assets: vtxo.assets,
    }))
  }

  async getBoardingUtxos(): Promise<Record<string, unknown>[]> {
    this.assertConnected()
    const utxos: any[] = await this.rawWallet.getBoardingUtxos()
    return (utxos ?? []).map((u: any) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      confirmed: u.status?.confirmed ?? false,
    }))
  }

  /** Onboard — settle confirmed boarding UTXOs into VTXOs via a Commitment Transaction. */
  async onboard(): Promise<{ txid: string }> {
    this.assertConnected()
    const wallet = this.rawWallet
    const info = await wallet.arkProvider.getInfo()
    const commitmentTxid: string = await new this.arkSdk.Ramps(wallet).onboard(info.fees)
    return { txid: commitmentTxid }
  }

  /** Offboard — collaborative exit: convert VTXOs back to an on-chain Bitcoin UTXO. */
  async offboard(address: string, amount?: number): Promise<{ txid: string }> {
    this.assertConnected()
    if (!address) throw new ProtocolError('Destination address required for offboard', 'ARKADE', 'INVALID_ADDRESS')
    if (amount !== undefined && (!Number.isInteger(amount) || amount <= 0)) {
      throw new ProtocolError(`Invalid offboard amount: ${amount}`, 'ARKADE', 'INVALID_AMOUNT')
    }
    const wallet = this.rawWallet
    const info = await wallet.arkProvider.getInfo()
    const exitTxid: string = await new this.arkSdk.Ramps(wallet).offboard(
      address,
      info.fees,
      amount !== undefined ? BigInt(amount) : undefined,
    )
    return { txid: exitTxid }
  }

  // --- Message signing ----------------------------------------------------
  async signMessage(message: string): Promise<string> {
    this.assertConnected()
    if (!this.mnemonic) throw new ProtocolError('Wallet mnemonic not available', 'ARKADE', 'NOT_CONNECTED')
    const { mnemonicToSeedSync } = await import('@scure/bip39')
    const { HDKey } = await import('@scure/bip32')
    const seed = mnemonicToSeedSync(this.mnemonic)
    const node = HDKey.fromMasterSeed(seed).derive("m/138'/1")
    if (!node.privateKey) {
      throw new ProtocolError('Failed to derive message-signing key', 'ARKADE', 'KEY_DERIVATION_ERROR')
    }
    return signLnMessage(message, node.privateKey)
  }

  async verifyMessage(message: string, signature: string): Promise<string> {
    return verifyLnMessage(message, signature)
  }

  /** Escape hatch for Arkade-specific ops (waitForLightningPayment, getLightningLimits, …) — allowlisted. */
  async executeProtocolOperation(operation: string, params: any): Promise<any> {
    return this.runAllowlistedOp(ARKADE_ALLOWED_OPS, operation, params)
  }

  // --- Private helpers ----------------------------------------------------
  /**
   * Rich balance summary derived from VTXOs + boarding UTXOs (ported from the native
   * adapter). The SDK's top-level `balance.total` omits the boarding portion, so we
   * recompute it: available = settled + preconfirmed; total includes boarding + recoverable.
   */
  private async getWalletBalanceSummary(): Promise<{
    boardingConfirmed: number
    boardingUnconfirmed: number
    boardingTotal: number
    settled: number
    preconfirmed: number
    available: number
    recoverable: number
    total: number
  }> {
    const wallet = this.rawWallet
    const balance: any = await wallet.getBalance()
    const normalized = {
      boardingConfirmed: toNumber(balance?.boarding?.confirmed),
      boardingUnconfirmed: toNumber(balance?.boarding?.unconfirmed),
      boardingTotal: toNumber(balance?.boarding?.total),
      settled: toNumber(balance?.settled),
      preconfirmed: toNumber(balance?.preconfirmed),
      available: toNumber(balance?.available),
      recoverable: toNumber(balance?.recoverable),
      total: toNumber(balance?.total),
    }

    let normalizedVtxos: ReturnType<typeof normalizeVtxos> = []
    try {
      normalizedVtxos = normalizeVtxos(await wallet.getVtxos())
    } catch {
      /* fall back to wallet.getBalance() */
    }
    if (normalizedVtxos.length === 0) {
      const available = normalized.settled + normalized.preconfirmed
      return { ...normalized, available, total: normalized.boardingTotal + available + normalized.recoverable }
    }

    const vtxoSummary = normalizedVtxos.reduce(
      (summary, vtxo) => {
        if (vtxo.state === 'swept') summary.recoverable += vtxo.value
        else if (vtxo.state === 'preconfirmed') summary.preconfirmed += vtxo.value
        else summary.settled += vtxo.value
        return summary
      },
      { settled: 0, preconfirmed: 0, recoverable: 0 },
    )
    const available = vtxoSummary.settled + vtxoSummary.preconfirmed
    return {
      ...normalized,
      settled: vtxoSummary.settled,
      preconfirmed: vtxoSummary.preconfirmed,
      available,
      recoverable: vtxoSummary.recoverable,
      total: normalized.boardingTotal + available + vtxoSummary.recoverable,
    }
  }
}
