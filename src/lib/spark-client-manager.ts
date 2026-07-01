/**
 * Spark Client Manager
 *
 * Manages the lifecycle of a SparkWallet from `@buildonspark/spark-sdk`.
 * The native SDK inlines WASM as a binary buffer (no dynamic import needed)
 * and uses gRPC over fetch, both of which are supported in an MV3
 * ServiceWorker and in Node — so the SDK is imported statically by default.
 *
 * Platform seam: consumers may inject an `SparkSdkFactory` via
 * `setSdkFactory()` to avoid the static import path (e.g. React Native /
 * Metro, where `import('@buildonspark/spark-sdk')` mis-bundles). When no
 * factory is set the static `SparkWallet.initialize` path is used.
 */

import type { SparkConfig } from '../types/spark'
import { log } from './log'
import { SparkWallet, SparkReadonlyClient } from '@buildonspark/spark-sdk'
import { saveSentTokenRecord } from './spark-sent-token-records'
import { bech32 } from '@scure/base'
import { bytesToHex } from '@noble/hashes/utils.js'

/** Matches the SDK's internal NetworkType (keyof typeof Network). Not exported by the SDK. */
type SparkNetworkType = 'MAINNET' | 'TESTNET' | 'SIGNET' | 'REGTEST' | 'LOCAL'

const NETWORK_MAP: Record<string, SparkNetworkType> = {
  mainnet: 'MAINNET',
  testnet: 'TESTNET',
  regtest: 'REGTEST',
  signet: 'SIGNET',
}

/**
 * Decode an `nsec1…` bech32 secret into a 32-byte private key hex, or null.
 * Mirrors the extension's `importNostrPrivateKey` nsec branch without pulling
 * in the nostr module — the Spark SDK accepts a raw hex seed via
 * `mnemonicOrSeed`, so an nsec-rooted wallet resolves to its hex private key.
 */
function nsecToPrivateKeyHex(input: string): string | null {
  try {
    const decoded = bech32.decode(input as `${string}1${string}`, 1023)
    if (decoded.prefix !== 'nsec') return null
    const data = bech32.fromWords(decoded.words)
    if (data.length !== 32) return null
    return bytesToHex(Uint8Array.from(data))
  } catch {
    return null
  }
}

/**
 * Resolve a Spark wallet secret to the value handed to the SDK. Accepts an
 * `nsec1…` root secret (resolved to hex), otherwise passes the input through
 * unchanged (the SDK handles BIP39 mnemonics and hex seeds itself).
 */
function resolveSparkMnemonicOrSeed(walletSecret: string): string {
  const trimmed = walletSecret.trim()
  if (trimmed.startsWith('nsec1')) {
    const hex = nsecToPrivateKeyHex(trimmed)
    if (hex) return hex
  }
  return walletSecret
}

/**
 * SDK factory injected by consumers to avoid the static import path.
 * Optional — when absent the manager uses the statically-imported SDK.
 */
export interface SparkSdkFactory {
  initializeWallet: (config: {
    mnemonicOrSeed: string
    options: { network: string }
  }) => Promise<{ wallet: any }>
}

// ---------------------------------------------------------------------------
// SparkClientManager
// ---------------------------------------------------------------------------

class SparkClientManager {
  private wallet: any = null
  private readonlyClient: SparkReadonlyClient | null = null
  private config: SparkConfig | null = null
  /** Serializes concurrent initialize() calls to prevent races during SW restart. */
  private _initPromise: Promise<void> | null = null
  /** Serializes concurrent readonly client initialization. */
  private _readonlyInitPromise: Promise<SparkReadonlyClient> | null = null
  /** Optional SDK factory escape hatch (React Native / Metro). */
  private sdkFactory: SparkSdkFactory | null = null

  /**
   * Inject an SDK factory before calling initialize(). Avoids the static
   * `@buildonspark/spark-sdk` import path on platforms where it mis-bundles.
   */
  setSdkFactory(factory: SparkSdkFactory): void {
    this.sdkFactory = factory
  }

  /**
   * Initialize the SparkWallet.
   * Concurrent calls share the same in-flight promise.
   */
  initialize(config: SparkConfig): Promise<void> {
    if (this._initPromise) return this._initPromise

    this._initPromise = this._doInitialize(config).finally(() => {
      this._initPromise = null
    })
    return this._initPromise
  }

  private async _doInitialize(config: SparkConfig): Promise<void> {
    if (this.wallet) {
      log.warn('[SparkClientManager] Wallet already initialized, re-initializing...')
      await this.disconnect()
    }

    const network: SparkNetworkType = NETWORK_MAP[config.network ?? 'mainnet'] ?? 'MAINNET'
    const mnemonicOrSeed = resolveSparkMnemonicOrSeed(config.mnemonic)

    try {
      let result: { wallet: any }
      if (this.sdkFactory) {
        result = await this.sdkFactory.initializeWallet({
          mnemonicOrSeed,
          options: { network },
        })
      } else {
        result = await SparkWallet.initialize({
          mnemonicOrSeed,
          options: { network: network as any },
        })
      }

      this.wallet = result.wallet
      this.config = config
      this.installTokenSendRecorder(this.wallet)
      log.info('[SparkClientManager] SparkWallet initialized, network:', network)

      // Enable privacy mode so BTC transactions are hidden from public APIs
      try {
        await this.wallet.setPrivacyEnabled(true)
        log.info('[SparkClientManager] Privacy mode enabled')
      } catch (privacyError: unknown) {
        const privMsg = privacyError instanceof Error ? privacyError.message : String(privacyError)
        log.warn('[SparkClientManager] Failed to enable privacy mode:', privMsg)
      }
    } catch (error: unknown) {
      this.wallet = null
      const msg = error instanceof Error ? error.message : String(error)
      throw Object.assign(new Error(`Failed to initialize SparkWallet: ${msg}`), { cause: error })
    }
  }

  /**
   * Wrap `transferTokens` so every outgoing token transfer — regardless of
   * caller (SparkAdapter.sendAsset, Flashnet swaps / liquidity, or any future
   * path) — is persisted to the sent-token outbox.
   *
   * The Spark SDK reports no direction for token transactions, so without a
   * local record an outgoing transfer is indistinguishable from a receive
   * (and a send with no change output is not returned by the server at all).
   * Recording at this single choke point guarantees no token send is missed.
   *
   * Metadata is minimal here; SparkAdapter.sendAsset re-saves the same hash
   * with full token metadata, which supersedes this entry (records are keyed
   * by hash). Paths with no richer recorder degrade to a generic "TOKEN" label.
   */
  private installTokenSendRecorder(wallet: any): void {
    if (typeof wallet?.transferTokens !== 'function') return
    const original = wallet.transferTokens.bind(wallet)
    wallet.transferTokens = async (params: any): Promise<string> => {
      const txId = await original(params)
      try {
        const senderSparkAddress = (await wallet.getSparkAddress()) as string
        await saveSentTokenRecord({
          hash: typeof txId === 'string' ? txId : String(txId),
          senderSparkAddress,
          amount: Number(params?.tokenAmount ?? 0n),
          assetId: String(params?.tokenIdentifier ?? ''),
          ticker: '',
          name: '',
          decimals: 0,
          timestamp: Date.now(),
        })
      } catch (err) {
        log.warn('[SparkClientManager] Failed to record token send:', err)
      }
      return txId
    }
  }

  /**
   * Return the active wallet instance.
   * Throws if initialize() has not been called successfully.
   */
  getWallet(): any {
    if (!this.wallet) {
      throw new Error('SparkWallet not initialized. Call initialize() first.')
    }
    return this.wallet
  }

  isInitialized(): boolean {
    return this.wallet !== null
  }

  getConfig(): SparkConfig | null {
    return this.config
  }

  async getReadonlyClient(): Promise<SparkReadonlyClient> {
    if (this.readonlyClient) return this.readonlyClient
    if (this._readonlyInitPromise) return this._readonlyInitPromise
    if (!this.config?.mnemonic) {
      throw new Error('SparkReadonlyClient cannot be created without mnemonic config.')
    }

    const network: SparkNetworkType = NETWORK_MAP[this.config.network ?? 'mainnet'] ?? 'MAINNET'

    this._readonlyInitPromise = (async () => {
      const mnemonicOrSeed = resolveSparkMnemonicOrSeed(this.config!.mnemonic)
      const client = await SparkReadonlyClient.createWithMasterKey({ network }, mnemonicOrSeed)
      this.readonlyClient = client
      return client
    })().finally(() => {
      this._readonlyInitPromise = null
    })

    return this._readonlyInitPromise
  }

  /**
   * Register an event listener on the wallet (e.g. incoming transfer notifications).
   */
  on(event: string, listener: (...args: unknown[]) => void): void {
    type WalletWithOn = {
      on?: (eventName: string, callback: (...args: unknown[]) => void) => void
    }
    ;(this.wallet as WalletWithOn | null)?.on?.(event, listener)
  }

  /**
   * Disconnect and release resources.
   */
  async disconnect(): Promise<void> {
    if (this.wallet) {
      try {
        await this.wallet.cleanupConnections()
        log.info('[SparkClientManager] Wallet disconnected')
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log.warn('[SparkClientManager] Error during disconnect:', msg)
      }
    }
    this.wallet = null
    this.readonlyClient = null
    this.config = null
  }

  reset(): void {
    this.wallet = null
    this.readonlyClient = null
    this.config = null
    this._initPromise = null
    this._readonlyInitPromise = null
    log.info('[SparkClientManager] Complete reset performed')
  }
}

export const sparkClientManager = new SparkClientManager()
