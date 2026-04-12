/**
 * KaleidoClient Manager
 * Singleton manager for KaleidoClient lifecycle.
 * Ported from rate-extension/src/lib/kaleido-client-manager.ts
 */

import { KaleidoClient } from 'kaleido-sdk'

export interface KaleidoClientConfig {
  baseUrl: string
  nodeUrl?: string
  apiKey?: string
  timeout?: number
}

class KaleidoClientManager {
  private client: KaleidoClient | null = null
  private config: KaleidoClientConfig | null = null

  initialize(config: KaleidoClientConfig): void {
    this.config = config
    this.client = KaleidoClient.create({
      baseUrl: config.baseUrl,
      nodeUrl: config.nodeUrl,
      apiKey: config.apiKey,
      timeout: config.timeout,
    })

    console.log('[KaleidoClientManager] Initialized with config:', {
      baseUrl: config.baseUrl,
      hasNodeUrl: !!config.nodeUrl,
      hasApiKey: !!config.apiKey,
    })
  }

  getClient(): KaleidoClient {
    if (!this.client) {
      throw new Error('KaleidoClient not initialized. Call initialize() first.')
    }
    return this.client
  }

  isInitialized(): boolean {
    return this.client !== null
  }

  hasNode(): boolean {
    return !!this.config?.nodeUrl
  }

  getConfig(): KaleidoClientConfig | null {
    return this.config
  }

  reset(): void {
    this.client = null
    this.config = null
    console.log('[KaleidoClientManager] Reset complete')
  }

  updateConfig(config: Partial<KaleidoClientConfig>): void {
    if (!this.config) {
      throw new Error('Cannot update config: client not initialized')
    }
    const newConfig = { ...this.config, ...config }
    this.initialize(newConfig)
  }
}

export const kaleidoClientManager = new KaleidoClientManager()
