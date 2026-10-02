import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { BarkBackendError } from '../types/bark-native.js'
import type {
  BarkReactNativeConfig, BarkBalance, BarkArkPaymentRequest, BarkArkPaymentResult, BarkWalletInfo, BarkMovement,
} from '../types/bark-native.js'
import { positiveSats, nativeNumber, barkValue, vtxoIds } from './bark-convert.js'
import type { BarkWalletPort } from '../lib/bark-client.js'
import type { BarkValue, BarkFeeEstimate } from '../types/bark-native.js'
import { loadBarkNative } from './bark-native.js'
import type { NativeBarkWallet, NativeBarkOnchain, NativeBarkModule } from './bark-native.js'

const MAX_SATS = 2_100_000_000_000_000
// A second handle in this JS runtime must not open the same native database.
const openDirectories = new Set<string>()

function validation(message: string): never {
  throw new BarkBackendError('VALIDATION_ERROR', message)
}

function sats(value: bigint): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(MAX_SATS)) {
    throw new BarkBackendError('SDK_ERROR', 'Bark returned an invalid satoshi amount')
  }
  return Number(value)
}

function delta(value: bigint): number {
  if (typeof value !== 'bigint') throw new BarkBackendError('SDK_ERROR', 'Bark returned an invalid balance delta')
  return value < 0n ? -sats(-value) : sats(value)
}

function endpoint(value: string, network: BarkReactNativeConfig['network']): string {
  let url: URL
  try { url = new URL(value) } catch { return validation('Bark endpoints must be absolute URLs') }
  if (url.username || url.password || url.hash || url.search ||
      (url.protocol !== 'https:' && !(network === 'regtest' && url.protocol === 'http:'))) {
    validation('Bark endpoints require HTTPS (HTTP is allowed for regtest), without credentials, query or fragment')
  }
  return url.toString().replace(/\/$/, '')
}

function configuration(config: BarkReactNativeConfig): BarkReactNativeConfig {
  if (!config || !['mainnet', 'testnet', 'signet', 'regtest'].includes(config.network)) {
    validation('Select an explicit Bark network')
  }
  if (typeof config.mnemonic !== 'string' || !validateMnemonic(config.mnemonic, wordlist)) {
    validation('Bark requires a valid English BIP39 mnemonic')
  }
  if (typeof config.dataDir !== 'string' || !config.dataDir.startsWith('/') ||
      config.dataDir.includes('\0') || config.dataDir.includes('\\')) {
    validation('Bark requires an absolute app-private data directory path')
  }
  const parts = config.dataDir.split('/').filter(Boolean)
  if (!parts.length || parts.some(p => p === '.' || p === '..')) {
    validation('Bark data directory must not be root or contain relative segments')
  }
  if (config.vtxoRefreshExpiryThreshold !== undefined && (!Number.isInteger(config.vtxoRefreshExpiryThreshold) || config.vtxoRefreshExpiryThreshold < 0 || config.vtxoRefreshExpiryThreshold > 0xffffffff)) validation('Invalid VTXO refresh threshold')
  if (config.userAgent !== undefined && typeof config.userAgent !== 'string') validation('userAgent must be a string')
  if (config.onchain !== undefined && typeof config.onchain !== 'boolean') validation('onchain must be a boolean')
  if (config.createIfMissing !== undefined && typeof config.createIfMissing !== 'boolean') {
    validation('createIfMissing must be a boolean')
  }
  return {
    onchain: config.onchain ?? false,
    vtxoRefreshExpiryThreshold: config.vtxoRefreshExpiryThreshold,
    userAgent: config.userAgent,
    network: config.network,
    mnemonic: config.mnemonic,
    dataDir: '/' + parts.join('/'),
    serverUrl: endpoint(config.serverUrl, config.network),
    esploraUrl: endpoint(config.esploraUrl, config.network),
    createIfMissing: config.createIfMissing ?? false,
  }
}

/**
 * On-device Bark transport foundation. No platform filesystem, secure storage,
 * timers, daemon, or automatic funding. Hosts own directory and seed lifetimes.
 */
export class BarkReactNativeBackend {
  private wallet?: NativeBarkWallet
  private onchain?: NativeBarkOnchain
  private sdk?: NativeBarkModule
  private generation = 0
  private synced = false
  private info?: BarkWalletInfo
  private directory?: string
  private state: 'closed' | 'opening' | 'open' | 'closing' = 'closed'
  private tail: Promise<unknown> = Promise.resolve()
  private closing?: Promise<void>

  isConnected(): boolean { return this.state === 'open' }
  isSynced(): boolean { return this.isConnected() && this.synced }

  async connect(input: BarkReactNativeConfig): Promise<void> {
    if (this.state !== 'closed' || this.closing) {
      throw new BarkBackendError('ALREADY_CONNECTED', 'Disconnect Bark before opening another wallet')
    }
    const config = configuration(input)
    if (openDirectories.has(config.dataDir)) {
      throw new BarkBackendError('ALREADY_CONNECTED', 'Bark data directory is already open in this runtime')
    }
    openDirectories.add(config.dataDir)
    this.directory = config.dataDir
    this.state = 'opening'
    this.generation++
    return this.enqueue(async () => {
      let opened: NativeBarkWallet | undefined
      try {
        const sdk = await loadBarkNative().catch(() => {
          throw new BarkBackendError('SDK_UNAVAILABLE', 'Install @secondts/bark-react-native 0.25.0 and rebuild the native app')
        })
        const network = {
          mainnet: sdk.Network.Bitcoin, testnet: sdk.Network.Testnet,
          signet: sdk.Network.Signet, regtest: sdk.Network.Regtest,
        }[config.network]
        this.sdk = sdk
        const nativeConfig = {
          serverAddress: config.serverUrl,
          esploraAddress: config.esploraUrl,
          daemonManualSync: true,
          ...(config.vtxoRefreshExpiryThreshold === undefined ? {} : { vtxoRefreshExpiryThreshold: config.vtxoRefreshExpiryThreshold }),
          ...(config.userAgent === undefined ? {} : { userAgent: config.userAgent }),
        }
        if (config.onchain) {
          this.onchain = await sdk.OnchainWallet.default_(network, config.mnemonic, nativeConfig, config.dataDir)
        }
        opened = await sdk.Wallet.open(network, config.mnemonic, nativeConfig, {
          ...(this.onchain ? { onchain: this.onchain } : {}),
          datadir: config.dataDir,
          runDaemon: false,
          createIfNotExists: config.createIfMissing ?? false,
          createWithoutServer: false,
          skipRecovery: false,
        })
        const properties = await opened.properties()
        if (properties.network !== network) validation('Bark wallet network does not match the requested network')
        const recovery = opened.recoveryStatus()
        this.info = {
          network: config.network,
          fingerprint: properties.fingerprint,
          recovery: recovery.tag === 'NotRun' ? 'not-run' : recovery.tag === 'Failed' ? 'failed' :
            recovery.inner.report.isComplete ? 'complete' : 'incomplete',
        }
        this.wallet = opened
        if (this.state !== 'closing') this.state = 'open'
      } catch (error) {
        // Keep a handle if shutdown fails, so disconnect can retry safely.
        if (opened) {
          this.wallet = opened
          this.state = 'closing'
          try { await this.release() } catch { /* disconnect must retry cleanup */ }
        } else {
          try { await this.release() } catch { this.state = 'closing' }
        }
        if (error instanceof BarkBackendError) throw error
        // Native errors may include config/seed strings. Do not expose them.
        throw new BarkBackendError('SDK_ERROR', 'Bark could not open the wallet')
      }
    })
  }

  disconnect(): Promise<void> {
    if (this.closing) return this.closing
    if (this.state === 'closed') return Promise.resolve()
    this.state = 'closing'
    this.closing = this.enqueue(() => this.release()).finally(() => { this.closing = undefined })
    return this.closing
  }

  getWalletInfo(): Promise<BarkWalletInfo> {
    return this.withWallet(async () => ({ ...this.info! }))
  }

  getBalance(): Promise<BarkBalance> {
    return this.withWallet(async wallet => {
      const balance = await wallet.balance()
      return {
        spendableSats: sats(balance.spendableSats),
        pendingInRoundSats: sats(balance.pendingInRoundSats),
        pendingExitSats: sats(balance.pendingExitSats),
        pendingLightningSendSats: sats(balance.pendingLightningSendSats),
        claimableLightningReceiveSats: sats(balance.claimableLightningReceiveSats),
        pendingBoardSats: sats(balance.pendingBoardSats),
      }
    })
  }

  /** Native history order; deltas include fees and are not payment amounts. */
  getHistory(): Promise<BarkMovement[]> {
    return this.withWallet(async wallet => (await wallet.history()).map(movement => ({
      id: String(movement.id),
      state: movement.status,
      kind: movement.subsystemKind,
      intendedBalanceDeltaSats: delta(movement.intendedBalanceSats),
      effectiveBalanceDeltaSats: delta(movement.effectiveBalanceSats),
      feeSats: sats(movement.offchainFeeSats),
      createdAt: movement.createdAt,
      completedAt: movement.completedAt,
      paymentHash: movement.paymentHash,
      sentToAddresses: [...movement.sentToAddresses],
      receivedOnAddresses: [...movement.receivedOnAddresses],
    })))
  }

  getReceiveAddress(): Promise<string> {
    return this.withWallet(wallet => wallet.newAddress())
  }

  /** Explicitly progresses pending Bark operations; does not start a daemon. */
  sync(): Promise<void> {
    return this.withWallet(async wallet => {
      this.synced = false
      await wallet.sync()
      this.synced = true
    })
  }

  sendArkPayment(request: BarkArkPaymentRequest): Promise<BarkArkPaymentResult> {
    // Snapshot authorization before queueing so callers cannot mutate it in flight.
    const address = typeof request?.address === 'string' ? request.address.trim() : ''
    const amountSats = request?.amountSats
    const maxFeeSats = request?.maxFeeSats
    return this.withWallet(async wallet => {
      if (!address) validation('An Ark destination is required')
      if (!Number.isSafeInteger(amountSats) || amountSats <= 0 || amountSats > MAX_SATS) {
        validation('Bark payment amount must be a positive integer number of satoshis')
      }
      if (maxFeeSats !== undefined) {
        throw new BarkBackendError('NOT_SUPPORTED', 'Bark arkoor payments do not expose an enforceable fee cap')
      }
      if (!await wallet.validateArkoorAddress(address)) {
        validation('Bark cannot deliver to this Ark address on the current server and network')
      }
      try {
        await wallet.sendArkoorPayment(address, BigInt(amountSats))
      } catch {
        // A transport failure after submission is not evidence the payment failed.
        throw new BarkBackendError('PAYMENT_OUTCOME_UNKNOWN', 'Bark payment outcome is unknown; inspect wallet history before retrying')
      }
      return { status: 'submitted', address, amountSats }
    })
  }

  isBarkAddress(address: string): boolean {
    if (!this.isConnected()) return false
    try { return this.sdk?.validateArkAddress(address) ?? false } catch { return false }
  }

  /** Normalized port consumed by the shared BarkAdapter. */
  getWalletPort(): BarkWalletPort {
    const generation = this.generation
    const port: BarkWalletPort = {
      balance: () => this.getBalance(),
      properties: async () => {
        const info = await this.getWalletInfo()
        return { network: info.network, fingerprint: info.fingerprint }
      },
      arkInfo: () => this.withWallet(async w => {
        const info = await w.arkInfo()
        return info && {
          serverPubkey: info.serverPubkey, minBoardAmountSats: sats(info.minBoardAmountSats),
          requiredBoardConfirmations: info.requiredBoardConfirmations,
          roundIntervalSecs: nativeNumber(info.roundIntervalSecs), vtxoLifetime: info.vtxoLifetime,
        }
      }),
      history: () => this.withWallet(async w => (await w.history()).map(m => ({
        id: m.id, status: m.status, subsystemName: m.subsystemName, subsystemKind: m.subsystemKind,
        effectiveBalanceSats: delta(m.effectiveBalanceSats), intendedBalanceSats: delta(m.intendedBalanceSats),
        offchainFeeSats: sats(m.offchainFeeSats), createdAt: m.createdAt, completedAt: m.completedAt,
        paymentHash: m.paymentHash, lightningInvoice: m.lightningInvoice,
        sentToAddresses: [...m.sentToAddresses], receivedOnAddresses: [...m.receivedOnAddresses],
        inputVtxoIds: [...m.inputVtxoIds], outputVtxoIds: [...m.outputVtxoIds],
      }))),
      sync: () => this.sync(),
      newAddress: () => this.getReceiveAddress(),
      bolt11Invoice: r => this.withWallet(async w => {
        const invoice = await w.bolt11Invoice(positiveSats(r.amountSats), r.description, undefined)
        return { invoice: invoice.invoice, paymentHash: invoice.paymentHash, amountSats: sats(invoice.amountSats) }
      }),
      payLightningInvoice: r => this.mutate(async w => this.lightningStatus(await w.payLightningInvoice(
        r.invoice, r.amountSats === undefined ? undefined : positiveSats(r.amountSats), r.wait,
      ))),
      payLightningOffer: r => this.mutate(async w => this.lightningStatus(await w.payLightningOffer(
        r.offer, r.amountSats === undefined ? undefined : positiveSats(r.amountSats), r.wait,
      ))),
      lightningSendState: hash => this.withWallet(async w => this.lightningStatus(await w.lightningSendState(hash))),
      lightningReceiveState: hash => this.withWallet(async w => {
        const r = await w.lightningReceiveState(hash)
        return { state: r.state, amountSats: r.amountSats === undefined ? undefined : sats(r.amountSats),
          settledAt: r.settledAt === undefined ? undefined : nativeNumber(r.settledAt) }
      }),
      sendArkoorPayment: async (address, amountSats) => { await this.sendArkPayment({ address, amountSats }) },
      sendOnchain: (address, amount) => this.mutate(w => w.sendOnchain(address, positiveSats(amount))),
      broadcastTx: hex => this.mutate(w => w.broadcastTx(hex)),
      boardFundingAddress: () => this.withWallet(w => w.boardFundingAddress()),
      boardAmount: amount => this.mutate(async w => {
        this.requireOnchain()
        return this.pendingBoard(await w.boardAmount(positiveSats(amount)))
      }),
      boardAll: () => this.mutate(async w => {
        this.requireOnchain()
        return this.pendingBoard(await w.boardAll())
      }),
      pendingBoards: () => this.withWallet(async w => (await w.pendingBoards()).map(b => this.pendingBoard(b))),
    }
    return new Proxy(port, {
      get: (target, key) => {
        const method: unknown = Reflect.get(target, key)
        if (typeof method !== 'function') return method
        return (...args: unknown[]) => {
          if (generation !== this.generation) return Promise.reject(new BarkBackendError('NOT_CONNECTED', 'Bark wallet session changed'))
          return Reflect.apply(method, target, args)
        }
      },
    })
  }

  private pendingBoard(board: Awaited<ReturnType<NativeBarkWallet['boardAmount']>>) {
    return { vtxoId: board.vtxoId, amountSats: sats(board.amountSats), txid: board.txid }
  }

  private lightningStatus(s: Awaited<ReturnType<NativeBarkWallet['lightningSendState']>>) {
    if (s.tag === 'Paid') return { type: 'paid' as const, payment_hash: s.inner.paymentHash, preimage: s.inner.preimage }
    if (s.tag === 'InProgress') return { type: 'inProgress' as const, send: {
      amountSats: sats(s.inner.send.amountSats), feeSats: sats(s.inner.send.feeSats),
    } }
    return { type: 'unknown' as const }
  }

  getOnchainAddress(): Promise<string> {
    return this.withWallet(() => this.requireOnchain().newAddress())
  }

  getOnchainBalance(): Promise<{ confirmedSats: number; pendingSats: number; totalSats: number }> {
    return this.withWallet(async () => {
      const b = await this.requireOnchain().balance()
      return { confirmedSats: sats(b.confirmedSats), pendingSats: sats(b.pendingSats), totalSats: sats(b.totalSats) }
    })
  }

  syncOnchain(): Promise<void> {
    return this.withWallet(async () => { await this.requireOnchain().sync() })
  }

  restoreOnchain(): Promise<number> {
    return this.withWallet(async () => sats(await this.requireOnchain().initialScan(undefined)))
  }

  getVtxos(): Promise<BarkValue> { return this.withWallet(async w => barkValue(await w.vtxos())) }
  getExitStatus(): Promise<BarkValue> { return this.withWallet(async w => barkValue(await w.getExitVtxos())) }
  getPendingRounds(): Promise<BarkValue> { return this.withWallet(async w => barkValue(await w.pendingRoundStates())) }

  async refreshVtxos(ids: string[]): Promise<BarkValue> {
    const selected = vtxoIds(ids)
    return this.mutate(async w => barkValue(await w.refreshVtxosDelegated(selected)))
  }

  progressPendingRounds(): Promise<void> { return this.mutate(w => w.progressPendingRounds()) }

  async offboard(address: string, ids: string[]): Promise<{ txid: string }> {
    const selected = vtxoIds(ids)
    if (!address?.trim()) validation('An offboard destination is required')
    return this.mutate(w => w.offboardVtxos(selected, address))
  }

  async startExit(ids: string[]): Promise<void> {
    const selected = vtxoIds(ids)
    return this.mutate(w => w.startExitForVtxos(selected))
  }

  async progressExits(feeRateSatPerVb?: number): Promise<BarkValue> {
    const rate = feeRateSatPerVb === undefined ? undefined : positiveSats(feeRateSatPerVb)
    return this.mutate(async w => { this.requireOnchain(); return barkValue(await w.progressExits(rate)) })
  }

  /** Prepares and signs the selected exit claims. Broadcasting stays explicit. */
  async prepareExitClaim(ids: string[], address: string, feeRateSatPerVb?: number): Promise<{ transactionHex: string; feeSats: number }> {
    const selected = vtxoIds(ids)
    if (!address?.trim()) validation('An exit claim destination is required')
    const rate = feeRateSatPerVb === undefined ? undefined : positiveSats(feeRateSatPerVb)
    return this.withWallet(async w => {
      const claim = await w.drainExits(selected, false, address, rate)
      const signed = await w.signExitClaimInputs(claim.psbtBase64)
      return { transactionHex: this.sdk!.extractTxFromPsbt(signed), feeSats: sats(claim.feeSats) }
    })
  }

  async recoverVtxos(ids: string[]): Promise<BarkValue> {
    const selected = vtxoIds(ids)
    return this.withWallet(async w => barkValue(await w.recoverVtxos(selected, undefined)))
  }

  async estimatePaymentFee(kind: 'ark' | 'lightning' | 'onchain', amount: number, address?: string): Promise<BarkFeeEstimate> {
    const value = positiveSats(amount)
    return this.withWallet(async w => {
      let fee
      if (kind === 'ark') fee = await w.estimateArkoorPaymentFee(value)
      else if (kind === 'lightning') fee = await w.estimateLightningSendFee(value)
      else if (kind === 'onchain' && address) fee = await w.estimateSendOnchainFee(address, value)
      else return validation('A supported payment kind and destination are required')
      return { grossAmountSats: sats(fee.grossAmountSats), netAmountSats: sats(fee.netAmountSats),
        feeSats: sats(fee.feeSats), vtxosSpent: [...fee.vtxosSpent] }
    })
  }

  private requireOnchain(): NativeBarkOnchain {
    if (!this.onchain) throw new BarkBackendError('NOT_SUPPORTED', 'Enable the Bark onchain wallet for this operation')
    return this.onchain
  }

  private mutate<T>(operation: (wallet: NativeBarkWallet) => Promise<T>): Promise<T> {
    return this.withWallet(async wallet => {
      try { return await operation(wallet) } catch (e) {
        if (e instanceof BarkBackendError) throw e
        throw new BarkBackendError('PAYMENT_OUTCOME_UNKNOWN', 'Bark operation outcome is unknown; inspect wallet state before retrying')
      }
    })
  }

  private withWallet<T>(operation: (wallet: NativeBarkWallet) => Promise<T>): Promise<T> {
    if (this.state !== 'open') {
      return Promise.reject(new BarkBackendError('NOT_CONNECTED', 'Bark wallet is not connected'))
    }
    return this.enqueue(async () => {
      try { return await operation(this.wallet!) } catch (error) {
        if (error instanceof BarkBackendError) throw error
        throw new BarkBackendError('SDK_ERROR', 'Bark wallet operation failed')
      }
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => undefined)
    return result
  }

  private async release(): Promise<void> {
    try {
      await this.wallet?.stopDaemonWait()
      this.wallet?.uniffiDestroy?.()
      this.wallet = undefined
      this.onchain?.uniffiDestroy?.()
    } catch {
      throw new BarkBackendError('SDK_ERROR', 'Bark shutdown failed; retry disconnect before reopening the wallet')
    }
    this.reset()
  }

  private reset(): void {
    this.wallet = undefined
    this.onchain = undefined
    this.sdk = undefined
    this.info = undefined
    this.synced = false
    if (this.directory) openDirectories.delete(this.directory)
    this.directory = undefined
    this.state = 'closed'
  }
}
