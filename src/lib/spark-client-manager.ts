/**
 * Spark Client Manager
 * Manages the lifecycle of a SparkWallet from @buildonspark/spark-sdk.
 * Uses injected SDK factory to avoid dynamic import() issues in Metro.
 */

import type { SparkConfig } from '../types/spark'

type SparkWallet = any

/**
 * SDK factory injected by consumers.
 * Consumers must call `setSdkFactory()` before `initialize()`.
 */
export interface SparkSdkFactory {
  initializeWallet: (config: { mnemonicOrSeed: string; options: { network: string } }) => Promise<{ wallet: any }>
}

class SparkClientManager {
  private wallet: SparkWallet | null = null
  private config: SparkConfig | null = null
  private _initPromise: Promise<void> | null = null
  private sdkFactory: SparkSdkFactory | null = null

  /**
   * Set the SDK factory before calling initialize().
   * This avoids dynamic import() which breaks in Metro bundler.
   */
  setSdkFactory(factory: SparkSdkFactory): void {
    this.sdkFactory = factory
  }

  initialize(config: SparkConfig): Promise<void> {
    if (this._initPromise) return this._initPromise

    this._initPromise = this._doInitialize(config).finally(() => {
      this._initPromise = null
    })
    return this._initPromise
  }

  private async _doInitialize(config: SparkConfig): Promise<void> {
    if (this.wallet) {
      console.warn('[SparkClientManager] Wallet already initialized, re-initializing...')
      await this.disconnect()
    }

    const networkMap: Record<string, string> = {
      mainnet: 'MAINNET',
      testnet: 'TESTNET',
      regtest: 'REGTEST',
      signet: 'SIGNET',
    }
    const network = networkMap[config.network ?? 'mainnet'] ?? 'MAINNET'

    try {
      let result: { wallet: any }

      if (this.sdkFactory) {
        result = await this.sdkFactory.initializeWallet({
          mnemonicOrSeed: config.mnemonic,
          options: { network },
        })
      } else {
        // Fallback: dynamic import (works in Node/extension, may fail in Metro)
        const { SparkWallet } = await import('@buildonspark/spark-sdk')
        result = await SparkWallet.initialize({
          mnemonicOrSeed: config.mnemonic,
          options: { network: network as any },
        })
      }

      this.wallet = result.wallet
      this.config = config
      console.log('[SparkClientManager] SparkWallet initialized, network:', network)

      try {
        await this.wallet.setPrivacyEnabled(true)
        console.log('[SparkClientManager] Privacy mode enabled')
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        console.warn('[SparkClientManager] Failed to enable privacy mode:', msg)
      }
    } catch (error: unknown) {
      this.wallet = null
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to initialize SparkWallet: ${msg}`)
    }
  }

  async disconnect(): Promise<void> {
    if (this.wallet) {
      try {
        await this.wallet.cleanupConnections()
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        console.warn('[SparkClientManager] Error during cleanup:', msg)
      }
      this.wallet = null
    }
    this.config = null
  }

  isInitialized(): boolean {
    return this.wallet !== null
  }

  getWallet(): SparkWallet {
    if (!this.wallet) {
      throw new Error('[SparkClientManager] Wallet not initialized')
    }
    return this.wallet
  }

  getConfig(): SparkConfig | null {
    return this.config
  }
}

export const sparkClientManager = new SparkClientManager()
