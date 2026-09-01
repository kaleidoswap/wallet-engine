import { afterEach, describe, expect, it, vi } from 'vitest'

import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { KaleidoswapSwap } from '../../src/swap/KaleidoswapSwap'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'
import { getPlatform, setPlatform } from '../../src/ports'
import type { Quote } from '../../src/types/base'

const quote: Quote = {
  id: 'rfq-once',
  fromAsset: 'rgb:USDT',
  fromAmount: 100_000,
  toAsset: 'BTC',
  toAmount: 5_000,
  price: 20,
  fee: { amount: 10, asset: 'rgb:USDT' },
  expiresAt: Date.now() + 60_000,
  provider: 'kaleidoswap',
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function memoryPlatform() {
  const values = new Map<string, string>()
  return {
    storage: {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => { values.set(key, value) },
      remove: async (key: string) => { values.delete(key) },
      keys: async () => [...values.keys()],
    },
    runtime: { host: 'node' as const, randomBytes: (n: number) => new Uint8Array(n), now: () => 1_788_000_000_000 },
  }
}

function fill(paymentHash = 'payment-1') {
  return {
    paymentHash,
    accessToken: `token-${paymentHash}`,
    status: 'Waiting',
    tokenInAmount: quote.fromAmount,
    tokenOutAmount: quote.toAmount,
  }
}

afterEach(() => {
  kaleidoClientManager.reset()
  vi.restoreAllMocks()
})

describe('B-F3: approved RFQs execute at most once', () => {
  it('rejects an explicitly interleaved concurrent call while only one reaches the maker', async () => {
    const entered = deferred()
    const release = deferred()
    let calls = 0
    const swap = new KaleidoswapSwap({}, { baseUrl: 'https://maker', walletId: 'wallet-race' })
    ;(swap as any).proto = {
      swap: async () => {
        calls += 1
        entered.resolve()
        await release.promise
        return fill()
      },
    }

    const first = swap.executeSwap(quote)
    await entered.promise
    try {
      await expect(swap.executeSwap(quote)).rejects.toMatchObject({
        code: 'SWAP_IN_FLIGHT',
        details: { quoteId: quote.id },
      })
    } finally {
      release.resolve()
    }
    await first
    expect(calls).toBe(1)
  })

  it('rejects a sequential replay after the first execution completed', async () => {
    let calls = 0
    const swap = new KaleidoswapSwap({}, { baseUrl: 'https://maker', walletId: 'wallet-sequential' })
    ;(swap as any).proto = { swap: async () => (calls += 1, fill()) }
    await swap.executeSwap(quote)
    await expect(swap.executeSwap(quote)).rejects.toMatchObject({
      code: 'SWAP_ALREADY_EXECUTED',
      details: { quoteId: quote.id },
    })
    expect(calls).toBe(1)
  })

  it('rejects a replay after reconstructing the wrapper with the same storage namespace', async () => {
    const previousPlatform = getPlatform()
    setPlatform(memoryPlatform())
    let calls = 0
    const first = new KaleidoswapSwap({}, { baseUrl: 'https://maker', walletId: 'wallet-restart' })
    ;(first as any).proto = { swap: async () => (calls += 1, fill()) }
    try {
      await first.executeSwap(quote)
      const restarted = new KaleidoswapSwap({}, { baseUrl: 'https://maker', walletId: 'wallet-restart' })
      ;(restarted as any).proto = { swap: async () => (calls += 1, fill('payment-2')) }
      await expect(restarted.executeSwap(quote)).rejects.toMatchObject({
        code: 'SWAP_ALREADY_EXECUTED',
        details: { quoteId: quote.id },
      })
      expect(calls).toBe(1)
    } finally {
      if (previousPlatform) setPlatform(previousPlatform)
    }
  })

  it('applies the same replay guard to the native init/execute maker path', async () => {
    let executeCalls = 0
    const client = {
      maker: {
        initSwap: async () => ({ swapstring: 'ss', payment_hash: 'native-payment', access_token: 'native-token' }),
        executeSwap: async () => { executeCalls += 1 },
      },
      rln: { getTakerPubkey: async () => 'native-wallet', whitelistSwap: async () => {} },
    }
    ;(kaleidoClientManager as any).client = client
    ;(kaleidoClientManager as any).config = { baseUrl: 'https://maker', nodeUrl: 'https://node' }
    const adapter = new RgbAdapter()
    Object.assign(adapter as never, {
      connected: true,
      config: { makerUrl: 'https://maker', network: 'regtest' },
    })

    await adapter.executeSwap(quote)
    await expect(adapter.executeSwap(quote)).rejects.toMatchObject({
      code: 'SWAP_ALREADY_EXECUTED',
      details: { quoteId: quote.id },
    })
    expect(executeCalls).toBe(1)
  })
})
