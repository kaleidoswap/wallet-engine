/**
 * Flashnet Client Manager
 * Manages the lifecycle of a FlashnetClient from @flashnet/sdk.
 * Requires an initialized SparkWallet to function.
 * Ported from rate-extension/src/lib/flashnet-client-manager.ts
 */

import {
  BTC_ASSET_PUBKEY,
  getFlashnetNetworkForSpark,
  getFlashnetUsdbTokenAddress,
  type FlashnetNetwork,
} from '../types/flashnet'

/**
 * Normalize the SDK pools response to always return an array.
 * The SDK may return `Pool[]` or `{ pools: Pool[] }`.
 */
function normalizePoolsResponse(response: unknown): any[] {
  if (Array.isArray(response)) return response
  if (
    response &&
    typeof response === 'object' &&
    Array.isArray((response as { pools?: unknown[] }).pools)
  ) {
    return (response as { pools: unknown[] }).pools as any[]
  }
  return []
}

class FlashnetClientManager {
  private client: any = null
  private initPromise: Promise<void> | null = null
  private poolId: string | null = null
  private network: FlashnetNetwork | null = null

  /**
   * Initialize with a SparkWallet instance.
   * @param wallet - SparkWallet from @buildonspark/spark-sdk
   * @param sparkNetwork - The Spark network ('mainnet' | 'regtest')
   */
  initialize(wallet: any, sparkNetwork?: string): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this.doInitialize(wallet, sparkNetwork).finally(() => {
      this.initPromise = null
    })
    return this.initPromise
  }

  private async doInitialize(wallet: any, sparkNetwork?: string): Promise<void> {
    if (this.client) {
      await this.disconnect()
    }

    const network = getFlashnetNetworkForSpark(sparkNetwork)
    if (!network) {
      throw new Error('Flashnet is only available when Spark is on mainnet or regtest.')
    }

    try {
      const { FlashnetClient } = await import('@flashnet/sdk')
      this.client = new FlashnetClient(wallet)
      await this.client.initialize()
      this.network = network

      // Auto-discover the largest BTC/USDB pool
      try {
        const poolsResponse = await this.client.listPools({
          assetAAddress: BTC_ASSET_PUBKEY,
          assetBAddress: getFlashnetUsdbTokenAddress(network),
          sort: 'TVL_DESC',
        })
        const pools = normalizePoolsResponse(poolsResponse)
        if (pools && pools.length > 0) {
          this.poolId = pools[0].lpPublicKey
        }
      } catch (error) {
        console.warn('[FlashnetClientManager] Pool discovery failed:', error)
      }
    } catch (error) {
      this.client = null
      this.poolId = null
      this.network = null
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to initialize FlashnetClient: ${message}`)
    }
  }

  getClient(): any {
    if (!this.client) {
      throw new Error('FlashnetClient not initialized. Call initialize() first.')
    }
    return this.client
  }

  getPoolId(): string | null {
    return this.poolId
  }

  getNetwork(): FlashnetNetwork | null {
    return this.network
  }

  getUsdbTokenAddress(): string {
    if (!this.network) {
      throw new Error('Flashnet network unavailable. Initialize the client first.')
    }
    return getFlashnetUsdbTokenAddress(this.network)
  }

  isInitialized(): boolean {
    return this.client !== null
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.cleanup()
      } catch (error) {
        console.warn('[FlashnetClientManager] Disconnect error:', error)
      }
    }
    this.client = null
    this.poolId = null
    this.network = null
    this.initPromise = null
  }
}

export const flashnetClientManager = new FlashnetClientManager()
