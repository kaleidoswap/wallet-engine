import { afterEach, describe, expect, it, vi } from 'vitest'

import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { KaleidoswapSwap } from '../../src/swap/KaleidoswapSwap'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'
import { getPlatform, setPlatform } from '../../src/ports'
import type { Quote } from '../../src/types/base'

const quote: Quote = {
  id: 'rfq-durable',
  fromAsset: 'rgb:USDT',
  fromAmount: 100_000,
  toAsset: 'BTC',
  toAmount: 5_000,
  price: 20,
  fee: { amount: 10, asset: 'rgb:USDT' },
  expiresAt: Date.now() + 60_000,
  provider: 'kaleidoswap',
}

function platformStorage() {
  const values = new Map<string, string>()
  return {
    values,
    context: {
      storage: {
        get: async (key: string) => values.get(key) ?? null,
        set: async (key: string, value: string) => { values.set(key, value) },
        remove: async (key: string) => { values.delete(key) },
        keys: async () => [...values.keys()],
      },
      runtime: { host: 'node' as const, randomBytes: (n: number) => new Uint8Array(n), now: () => 1_788_000_000_000 },
    },
  }
}

function connectedNative(client: any): RgbAdapter {
  ;(kaleidoClientManager as any).client = client
  ;(kaleidoClientManager as any).config = { baseUrl: 'https://maker', nodeUrl: 'https://node' }
  const adapter = new RgbAdapter()
  Object.assign(adapter as never, {
    connected: true,
    config: { makerUrl: 'https://maker', network: 'regtest' },
  })
  return adapter
}

afterEach(() => {
  kaleidoClientManager.reset()
  vi.restoreAllMocks()
})

describe('B-F4: durable pre-execution swap recovery', () => {
  it('persists native init credentials before execution and recovers after a new adapter instance', async () => {
    const previousPlatform = getPlatform()
    const { values, context } = platformStorage()
    setPlatform(context)
    let executeSawDurableRecord = false
    let statusToken = ''
    const client = {
      maker: {
        initSwap: async () => ({
          swapstring: 'swap-string',
          payment_hash: 'payment-live',
          access_token: 'bearer-live',
        }),
        executeSwap: async () => {
          const records = [...values.values()].map((raw) => JSON.parse(raw))
          executeSawDurableRecord = records.some((record) =>
            record.quoteId === quote.id &&
            record.paymentHash === 'payment-live' &&
            record.accessToken === 'bearer-live' &&
            record.state === 'executing',
          )
          throw new Error('response lost after maker accepted execution')
        },
        getAtomicSwapStatus: async (request: any) => {
          statusToken = request.access_token
          return { swap: { status: 'Succeeded', qty_from: 100_000, qty_to: 5_000 } }
        },
      },
      rln: {
        getTakerPubkey: async () => 'public-wallet-id',
        whitelistSwap: async () => {},
      },
    }
    try {
      await expect(connectedNative(client).executeSwap(quote)).rejects.toThrow(/execute swap/i)
      expect(executeSawDurableRecord).toBe(true)

      const restarted = connectedNative(client)
      expect(await restarted.listIncompleteSwaps()).toMatchObject([{
        quoteId: quote.id,
        paymentHash: 'payment-live',
        accessToken: 'bearer-live',
        state: 'execution_unknown',
      }])
      const resumed = await restarted.resumeSwap(quote.id)
      expect(resumed.status).toBe('confirmed')
      expect(statusToken).toBe('bearer-live')
    } finally {
      if (previousPlatform) setPlatform(previousPlatform)
    }
  })

  it('reuses a WDK result token from storage after reconstructing the wrapper', async () => {
    const previousPlatform = getPlatform()
    const { context } = platformStorage()
    setPlatform(context)
    let statusToken = ''
    const first = new KaleidoswapSwap({}, { baseUrl: 'https://maker', walletId: 'wallet-public-id' })
    ;(first as any).proto = {
      swap: async () => ({
        paymentHash: 'wdk-payment',
        accessToken: 'wdk-bearer',
        status: 'Waiting',
        tokenInAmount: quote.fromAmount,
        tokenOutAmount: quote.toAmount,
      }),
    }
    try {
      await first.executeSwap(quote)
      const otherWallet = new KaleidoswapSwap({}, { baseUrl: 'https://maker', walletId: 'different-wallet' })
      expect(await otherWallet.listIncompleteSwaps()).toEqual([])
      const restarted = new KaleidoswapSwap({}, { baseUrl: 'https://maker', walletId: 'wallet-public-id' })
      ;(restarted as any).proto = {
        getOrderStatus: async (_hash: string, token: string) => {
          statusToken = token
          return { payment_hash: 'wdk-payment', status: 'Pending', qty_from: 100_000, qty_to: 5_000 }
        },
      }
      await restarted.resumeSwap(quote.id)
      expect(statusToken).toBe('wdk-bearer')
    } finally {
      if (previousPlatform) setPlatform(previousPlatform)
    }
  })
})
