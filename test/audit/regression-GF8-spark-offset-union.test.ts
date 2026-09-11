import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ wallet: null as any }))
vi.mock('../../src/lib/spark-client-manager', () => ({
  sparkClientManager: {
    isInitialized: () => state.wallet !== null,
    getWallet: () => state.wallet,
    getConfig: () => ({ protocol: 'SPARK', network: 'regtest', mnemonic: '' }),
  },
}))

import { SparkAdapter } from '../../src/adapters/SparkAdapter'
import { SparkWdkAdapter } from '../../src/adapters/wdk/SparkWdkAdapter'
import { ME, OTHER } from '../fixtures/spark'

const transfers = Array.from({ length: 8 }, (_, i) => ({
  id: `btc-${i}`,
  sparkId: `btc-${i}`,
  receiverIdentityPublicKey: ME,
  senderIdentityPublicKey: OTHER,
  transferDirection: 'INCOMING',
  totalValue: 1,
  status: 'TRANSFER_STATUS_COMPLETED',
  createdTime: new Date(2_000_000_000_000 - i),
  updatedTime: new Date(2_000_000_000_000 - i),
}))

afterEach(() => { state.wallet = null })

describe('G-F8 offset residual: page the merged Spark union', () => {
  it('native over-fetches from zero through offset + limit', async () => {
    let request: unknown
    state.wallet = {
      getTransfers: async (limit: number, offset: number) => {
        request = { limit, offset }
        return { transfers: transfers.slice(offset, offset + limit) }
      },
      getSparkAddress: async () => 'spark1self',
      getIdentityPublicKey: async () => ME,
      getBalance: async () => ({ balance: 0n, tokenBalances: new Map() }),
      queryTokenTransactions: async () => { throw new Error('unavailable') },
    }
    const page = await new SparkAdapter().listTransactions({ offset: 3, limit: 2 })
    expect(request).toEqual({ limit: 5, offset: 0 })
    expect(page.map((tx) => tx.id)).toEqual(['btc-3', 'btc-4'])
  })

  it('WDK over-fetches from zero through offset + limit', async () => {
    let request: unknown
    const adapter = new SparkWdkAdapter()
    Object.assign(adapter as never, {
      connected: true,
      identityPubKeyHex: ME.toLowerCase(),
      account: {
        getTransfers: async (params: { limit: number; skip: number }) => {
          request = params
          return transfers.slice(params.skip, params.skip + params.limit)
        },
      },
    })
    const page = await adapter.listTransactions({ offset: 3, limit: 2 })
    expect(request).toEqual({ limit: 5, skip: 0 })
    expect(page.map((tx) => tx.id)).toEqual(['btc-3', 'btc-4'])
  })
})
