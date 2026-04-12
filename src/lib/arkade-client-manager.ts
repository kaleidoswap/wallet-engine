/**
 * Arkade Client Manager
 * Manages the lifecycle of an Arkade wallet (@arkade-os/sdk).
 * Platform-agnostic: storage/providers are injected by consumers.
 * BIP86 key derivation via @scure/bip39 + @scure/bip32.
 */

import type { ArkadeConfig } from '../types/arkade'
import { mnemonicToSeedSync } from '@scure/bip39'
import { HDKey } from '@scure/bip32'

type ArkadeWallet = any

/**
 * Platform-specific providers injected by consumers.
 */
export interface ArkadePlatformProviders {
  createArkProvider?: () => any
  createIndexerProvider?: () => any
  createWalletRepository?: () => any
  createContractRepository?: () => any
}

/**
 * SDK factory injected by consumers.
 * Consumers must call `setArkadeSdkFactory()` before `initialize()`.
 */
export interface ArkadeSdkFactory {
  createWallet: (config: any) => Promise<any>
  createIdentity: (privateKeyHex: string) => any
}

function derivePrivateKeyFromMnemonic(
  mnemonic: string,
  isMainnet: boolean,
): string {
  const seed = mnemonicToSeedSync(mnemonic)
  const root = HDKey.fromMasterSeed(seed)
  const coinType = isMainnet ? 0 : 1
  const child = root.derive(`m/86'/${coinType}'/0'/0/0`)
  if (!child.privateKey) {
    throw new Error('Failed to derive private key from mnemonic')
  }
  return Array.from(child.privateKey).map(b => b.toString(16).padStart(2, '0')).join('')
}

class ArkadeClientManager {
  private wallet: ArkadeWallet | null = null
  private config: ArkadeConfig | null = null
  private _initPromise: Promise<void> | null = null
  private platformProviders: ArkadePlatformProviders = {}
  private sdkFactory: ArkadeSdkFactory | null = null

  setPlatformProviders(providers: ArkadePlatformProviders): void {
    this.platformProviders = providers
  }

  /**
   * Set the SDK factory before calling initialize().
   * This avoids dynamic import() which breaks in some bundlers.
   */
  setSdkFactory(factory: ArkadeSdkFactory): void {
    this.sdkFactory = factory
  }

  initialize(config: ArkadeConfig): Promise<void> {
    if (this._initPromise) return this._initPromise

    this._initPromise = this._doInitialize(config).finally(() => {
      this._initPromise = null
    })
    return this._initPromise
  }

  private async _doInitialize(config: ArkadeConfig): Promise<void> {
    if (this.wallet) {
      console.warn('[ArkadeClientManager] Wallet already initialized, re-initializing...')
      await this.disconnect()
    }

    try {
      const isMainnet = config.network === 'mainnet'
      const privateKeyHex = derivePrivateKeyFromMnemonic(config.mnemonic, isMainnet)

      const arkServerUrl = config.arkServerUrl

      const walletConfig: Record<string, any> = {
        arkServerUrl,
      }

      // Only pass esploraUrl if explicitly configured (SDK defaults to mempool.space)
      if (config.esploraUrl) {
        walletConfig.esploraUrl = config.esploraUrl
      }

      // Storage repositories (IndexedDB for extension, AsyncStorage for RN)
      const storage: Record<string, any> = {}
      if (this.platformProviders.createWalletRepository) {
        storage.walletRepository = this.platformProviders.createWalletRepository()
      }
      if (this.platformProviders.createContractRepository) {
        storage.contractRepository = this.platformProviders.createContractRepository()
      }
      if (Object.keys(storage).length > 0) {
        walletConfig.storage = storage
      }

      // Settlement config (VTXO lifecycle)
      walletConfig.settlementConfig = {
        vtxoThreshold: config.vtxoThresholdSeconds ?? 259200, // 3 days default
        boardingUtxoSweep: true,
        pollIntervalMs: 60_000,
      }

      // Platform-specific providers
      if (this.platformProviders.createArkProvider) {
        walletConfig.arkProvider = this.platformProviders.createArkProvider()
      }
      if (this.platformProviders.createIndexerProvider) {
        walletConfig.indexerProvider = this.platformProviders.createIndexerProvider()
      }

      if (this.sdkFactory) {
        walletConfig.identity = this.sdkFactory.createIdentity(privateKeyHex)
        this.wallet = await this.sdkFactory.createWallet(walletConfig)
      } else {
        const { Wallet, SingleKey } = await import('@arkade-os/sdk')
        walletConfig.identity = SingleKey.fromHex(privateKeyHex)
        this.wallet = await Wallet.create(walletConfig as any)
      }

      this.config = config
      console.log('[ArkadeClientManager] Arkade wallet initialized, network:', config.network || 'signet')
    } catch (error: unknown) {
      this.wallet = null
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to initialize Arkade wallet: ${msg}`)
    }
  }

  async disconnect(): Promise<void> {
    this.wallet = null
    this.config = null
  }

  isInitialized(): boolean {
    return this.wallet !== null
  }

  getWallet(): ArkadeWallet {
    if (!this.wallet) {
      throw new Error('[ArkadeClientManager] Wallet not initialized')
    }
    return this.wallet
  }

  getConfig(): ArkadeConfig | null {
    return this.config
  }
}

export const arkadeClientManager = new ArkadeClientManager()
