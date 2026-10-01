import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { BarkBackendError } from '../types/bark-native.js'
import type {
  BarkReactNativeConfig, BarkBalance, BarkArkPaymentRequest, BarkArkPaymentResult, BarkWalletInfo, BarkMovement,
} from '../types/bark-native.js'
import { loadBarkNative } from './bark-native.js'
import type { NativeBarkWallet } from './bark-native.js'

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
  if (config.createIfMissing !== undefined && typeof config.createIfMissing !== 'boolean') {
    validation('createIfMissing must be a boolean')
  }
  return {
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
  private info?: BarkWalletInfo
  private directory?: string
  private state: 'closed' | 'opening' | 'open' | 'closing' = 'closed'
  private tail: Promise<unknown> = Promise.resolve()
  private closing?: Promise<void>

  isConnected(): boolean { return this.state === 'open' }

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
        opened = await sdk.Wallet.open(network, config.mnemonic, {
          serverAddress: config.serverUrl,
          esploraAddress: config.esploraUrl,
          daemonManualSync: true,
        }, {
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
          this.reset()
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
    return this.withWallet(wallet => wallet.sync())
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
    } catch {
      throw new BarkBackendError('SDK_ERROR', 'Bark shutdown failed; retry disconnect before reopening the wallet')
    }
    this.reset()
  }

  private reset(): void {
    this.wallet = undefined
    this.info = undefined
    if (this.directory) openDirectories.delete(this.directory)
    this.directory = undefined
    this.state = 'closed'
  }
}
