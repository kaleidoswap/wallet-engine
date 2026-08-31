/**
 * Spark Client Manager
 *
 * Lifecycle of a SparkWallet from `@buildonspark/spark-sdk`. The SDK inlines WASM
 * as a binary buffer and uses gRPC over fetch, both fine in an MV3 service worker
 * and in Node, so it is imported statically by default.
 *
 * Platform seam: consumers may inject a `SparkSdkFactory` via `setSdkFactory()` to
 * avoid that static import (React Native / Metro mis-bundles it).
 */

import type { SparkConfig } from '../types/spark'
import { log } from './log'
import { SparkWallet, SparkReadonlyClient } from '@buildonspark/spark-sdk'
import { saveSentTokenRecord } from './spark-sent-token-records'
import { bech32 } from '@scure/base'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { WalletSessionGuard, type SessionAttempt } from './wallet-session'

/** Matches the SDK's internal NetworkType (keyof typeof Network). Not exported by the SDK. */
type SparkNetworkType = 'MAINNET' | 'TESTNET' | 'SIGNET' | 'REGTEST' | 'LOCAL'

const NETWORK_MAP: Record<string, SparkNetworkType> = {
  mainnet: 'MAINNET',
  testnet: 'TESTNET',
  regtest: 'REGTEST',
  signet: 'SIGNET',
}

/**
 * Decode an `nsec1…` secret into a 32-byte private key hex, or null. The Spark SDK
 * accepts a raw hex seed via `mnemonicOrSeed`, so an nsec-rooted wallet resolves
 * to its hex private key.
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
 * Resolve a Spark wallet secret for the SDK: `nsec1…` resolves to hex, anything
 * else passes through (the SDK handles mnemonics and hex seeds itself).
 */
export function resolveSparkMnemonicOrSeed(walletSecret: string): string {
  const trimmed = walletSecret.trim()
  if (trimmed.startsWith('nsec1')) {
    const hex = nsecToPrivateKeyHex(trimmed)
    if (hex) return hex
    // Never let a malformed nsec fall through as if it were a mnemonic/seed —
    // the SDK would derive a valid-but-different empty wallet from it.
    throw new Error('Invalid wallet secret: nsec1… failed to decode to a 32-byte key')
  }
  return walletSecret
}

/**
 * SDK factory injected by consumers to avoid the static import path. Optional.
 */
export interface SparkSdkFactory {
  initializeWallet: (config: {
    mnemonicOrSeed: string
    options: { network: string }
  }) => Promise<{ wallet: any }>
}

// ---------------------------------------------------------------------------
// SparkClientManager
/**
 * Stable identity for the wallet a config denotes, used only to decide whether
 * two `initialize()` calls are for the same wallet. Hashed so the manager never
 * holds a second comparable copy of the secret.
 */
function walletKey(config: SparkConfig): string {
  return `${config.network ?? 'mainnet'}:${bytesToHex(sha256(utf8ToBytes(config.mnemonic ?? '')))}`
}

// ---------------------------------------------------------------------------

/** The guard's two slots: the wallet handshake, and the readonly-client build. */
const WALLET_SLOT = 'wallet'
const READONLY_SLOT = 'readonly'

class SparkClientManager {
  private wallet: any = null
  private readonlyClient: SparkReadonlyClient | null = null
  private config: SparkConfig | null = null
  /**
   * Wallet identity + generation guard, shared with the other client managers.
   * Both slots hang off one generation, so any teardown invalidates the wallet
   * handshake and the readonly-client build together. `walletKey` hashes the
   * secret, so the guard never holds a second comparable copy of key material.
   * See src/lib/wallet-session.ts.
   */
  private readonly session = new WalletSessionGuard({ name: 'SparkClientManager' })
  /** Optional SDK factory escape hatch (React Native / Metro). */
  private sdkFactory: SparkSdkFactory | null = null

  /**
   * Inject an SDK factory before initialize(), for platforms where the static
   * `@buildonspark/spark-sdk` import mis-bundles.
   */
  setSdkFactory(factory: SparkSdkFactory): void {
    this.sdkFactory = factory
  }

  /** Initialize the SparkWallet. Concurrent calls share the in-flight promise. */
  initialize(config: SparkConfig): Promise<void> {
    return this.session.begin(WALLET_SLOT, walletKey(config), (attempt) =>
      this._doInitialize(config, attempt),
    )
  }

  private async _doInitialize(config: SparkConfig, attempt: SessionAttempt): Promise<void> {
    if (this.wallet) {
      log.warn('[SparkClientManager] Wallet already initialized, re-initializing...')
      await this.disconnect()
    }

    // Marked AFTER the re-init disconnect above, which invalidates the session itself.
    attempt.mark()
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

      // A disconnect()/reset()/wallet-switch that landed while the handshake was
      // pending has already torn this session down. Installing now would undo it:
      // the locked wallet would come back live and signing-capable, and
      // `this.config` would restore the mnemonic. Drop the orphan instead.
      if (!(await attempt.claim(() => result.wallet?.cleanupConnections?.()))) return

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
      // Only clear the wallet if this init still owns the session; a failure here
      // must not tear down a newer, successful one.
      if (attempt.isCurrent) this.wallet = null
      const msg = error instanceof Error ? error.message : String(error)
      throw Object.assign(new Error(`Failed to initialize SparkWallet: ${msg}`), { cause: error })
    }
  }

  /**
   * Adopt an externally-owned SparkWallet (e.g. the WDK Spark adapter's) WITHOUT
   * initializing a second one, so hosts driving Spark through WDK keep the
   * flashnet/bridge glue that reads `getWallet()`/`getConfig()`. Idempotent per
   * instance. `mnemonic` is empty — adopted wallets never re-derive.
   */
  adoptExternalWallet(wallet: any, network: string): void {
    if (!wallet || this.wallet === wallet) return
    this.wallet = wallet
    this.config = { protocol: 'SPARK', network: network as SparkConfig['network'], mnemonic: '' }
    this.installTokenSendRecorder(this.wallet)
  }

  /**
   * Release a wallet handed over by `adoptExternalWallet` (finding A5), so tearing
   * down the adapter that owns it also revokes this singleton's signing capability.
   *
   * No-op unless the singleton still holds exactly that wallet — another owner may
   * have adopted since, and dropping a live wallet that is not ours would be a
   * worse bug than the one this closes.
   */
  releaseExternalWallet(wallet: any): void {
    if (!this.session.releaseIf(this.wallet, wallet)) return
    this.wallet = null
    this.readonlyClient = null
    this.config = null
  }

  /**
   * Wrap `transferTokens` so every outgoing token transfer is persisted to the
   * sent-token outbox, whatever the caller.
   *
   * The Spark SDK reports no direction for token transactions, so without a local
   * record an outgoing transfer is indistinguishable from a receive (and a send
   * with no change output is not returned by the server at all). Recording at this
   * one choke point guarantees no send is missed.
   *
   * Metadata is minimal; SparkAdapter.sendAsset re-saves the same hash with full
   * metadata and supersedes this entry (records are keyed by hash).
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

  /** Return the active wallet instance. Throws if initialize() has not run. */
  getWallet(): any {
    if (!this.wallet) {
      throw new Error('SparkWallet not initialized. Call initialize() first.')
    }
    return this.wallet
  }

  isInitialized(): boolean {
    return this.wallet !== null
  }

  /**
   * Connected config with the mnemonic REDACTED — one careless
   * `log(getConfig())` in a host would otherwise leak the seed.
   */
  getConfig(): SparkConfig | null {
    return this.config ? { ...this.config, mnemonic: '' } : null
  }

  async getReadonlyClient(): Promise<SparkReadonlyClient> {
    if (this.readonlyClient) return this.readonlyClient
    if (!this.config?.mnemonic) {
      throw new Error('SparkReadonlyClient cannot be created without mnemonic config.')
    }

    const config = this.config
    const network: SparkNetworkType = NETWORK_MAP[config.network ?? 'mainnet'] ?? 'MAINNET'

    // Guarded by the same session as the wallet handshake, on its own slot: a
    // build started before a disconnect()/wallet switch is keyed to the PREVIOUS
    // wallet's master key, so it must neither be shared with the next session's
    // reader nor cached once it lands.
    return this.session.begin(READONLY_SLOT, walletKey(config), async (attempt) => {
      const mnemonicOrSeed = resolveSparkMnemonicOrSeed(config.mnemonic)
      const client = await SparkReadonlyClient.createWithMasterKey({ network }, mnemonicOrSeed)
      // A disconnect()/reset()/wallet switch landed while the client was being
      // built. Caching it would keep a live read capability on a wallet the host
      // has already wiped — and the `if (this.readonlyClient) return` fast path
      // above would then serve it past the mnemonic gate, to the next wallet's
      // session. Discard the orphan.
      if (!(await attempt.claim())) {
        throw new Error('SparkReadonlyClient init superseded by teardown')
      }
      this.readonlyClient = client
      return client
    })
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
    this.session.invalidate()
  }

  reset(): void {
    this.wallet = null
    this.readonlyClient = null
    this.config = null
    this.session.invalidate()
    log.info('[SparkClientManager] Complete reset performed')
  }
}

export const sparkClientManager = new SparkClientManager()
