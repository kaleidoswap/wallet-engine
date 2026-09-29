import { afterEach, describe, expect, it } from 'vitest'

import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { KaleidoswapSwap } from '../../src/swap/KaleidoswapSwap'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'
import { verifySwapstring } from '../../src/lib/swap-money'
import type { Quote } from '../../src/types/base'

/**
 * The swapstring the maker returns on init is what the taker's node whitelists,
 * and the node knows nothing about the approved quote. A hostile or buggy maker
 * that returns different terms must be refused before whitelisting.
 */
const HASH = 'e'.repeat(64)
const OTHER_HASH = 'f'.repeat(64)

function approved(id: string): Quote {
  return {
    id,
    fromAsset: 'BTC',
    fromAmount: 100_000,
    toAsset: 'rgb:USDT',
    toAmount: 1_000,
    price: 100,
    fee: { amount: 0, asset: 'BTC' },
    expiresAt: Date.now() + 60_000,
    provider: 'kaleidoswap',
  }
}

const GOOD = `100000/btc/1000/rgb:USDT/1790000000/${HASH}`
const HOSTILE: Array<[string, string]> = [
  ['inflated from amount', `1000000/btc/1000/rgb:USDT/1790000000/${HASH}`],
  ['shrunk to amount', `100000/btc/1/rgb:USDT/1790000000/${HASH}`],
  ['substituted to asset', `100000/btc/1000/rgb:WORTHLESS/1790000000/${HASH}`],
  ['substituted from asset', `100000/rgb:USDT/1000/rgb:USDT/1790000000/${HASH}`],
  ['different payment hash', `100000/btc/1000/rgb:USDT/1790000000/${OTHER_HASH}`],
  ['non-numeric amount', `100000abc/btc/1000/rgb:USDT/1790000000/${HASH}`],
  ['wrong field count', `100000/btc/1000/rgb:USDT/${HASH}`],
]

afterEach(() => kaleidoClientManager.reset())

describe('verifySwapstring', () => {
  it('accepts the approved terms, with BTC in any case', () => {
    expect(() => verifySwapstring(GOOD, approved('q'), HASH)).not.toThrow()
    expect(() =>
      verifySwapstring(GOOD.replace('/btc/', '/BTC/'), approved('q'), HASH),
    ).not.toThrow()
  })

  it.each(HOSTILE)('refuses a %s', (_, swapstring) => {
    expect(() => verifySwapstring(swapstring, approved('q'), HASH)).toThrow(
      expect.objectContaining({ code: 'SWAPSTRING_MISMATCH' }),
    )
  })
})

describe('RgbAdapter.executeSwap binds the swapstring to the approval', () => {
  function adapterWith(swapstring: string) {
    const calls = { whitelisted: [] as string[], executed: 0 }
    ;(kaleidoClientManager as any).client = {
      maker: {
        initSwap: async () => ({ swapstring, payment_hash: HASH, access_token: 'tok' }),
        executeSwap: async () => { calls.executed += 1 },
      },
      rln: {
        getTakerPubkey: async () => 'pub',
        whitelistSwap: async ({ swapstring: s }: { swapstring: string }) => { calls.whitelisted.push(s) },
      },
    }
    const adapter = new RgbAdapter()
    Object.assign(adapter as never, {
      connected: true,
      config: { makerUrl: 'https://maker', network: 'regtest' },
    })
    return { adapter, calls }
  }

  it('whitelists and executes a matching swapstring', async () => {
    const { adapter, calls } = adapterWith(GOOD)
    await adapter.executeSwap(approved('native-good'))
    expect(calls.whitelisted).toEqual([GOOD])
    expect(calls.executed).toBe(1)
  })

  it.each(HOSTILE)('never whitelists a %s', async (_, swapstring) => {
    const { adapter, calls } = adapterWith(swapstring)
    await expect(adapter.executeSwap(approved(`native-${swapstring}`))).rejects.toMatchObject({
      code: 'SWAPSTRING_MISMATCH',
    })
    expect(calls.whitelisted).toEqual([])
    expect(calls.executed).toBe(0)
  })
})

describe('KaleidoswapSwap.executeSwap binds the swapstring to the approval', () => {
  // Mirrors the swap module: init at the maker, whitelist via the account, execute.
  function swapWith(swapstring: string) {
    const calls = { whitelisted: [] as string[], executed: 0 }
    const account = {
      atomicTaker: async (s: string) => { calls.whitelisted.push(s) },
      getTakerPubkey: async () => 'pub',
    }
    const swap = new KaleidoswapSwap(account, { baseUrl: 'https://maker', walletId: `w-${swapstring}` })
    const guarded = (swap as any).guardedAccount()
    ;(swap as any).proto = {
      swap: async (opts: any) => {
        await guarded.atomicTaker(swapstring)
        await guarded.getTakerPubkey()
        calls.executed += 1
        return {
          paymentHash: HASH,
          swapstring,
          accessToken: 'tok',
          status: 'Waiting',
          tokenInAmount: opts.tokenInAmount,
          tokenOutAmount: opts.tokenOutAmount,
        }
      },
    }
    return { swap, calls }
  }

  it('whitelists and executes a matching swapstring', async () => {
    const { swap, calls } = swapWith(GOOD)
    await swap.executeSwap(approved('wdk-good'))
    expect(calls.whitelisted).toEqual([GOOD])
    expect(calls.executed).toBe(1)
  })

  it.each(HOSTILE.filter(([name]) => name !== 'different payment hash'))(
    'never whitelists a %s',
    async (_, swapstring) => {
      const { swap, calls } = swapWith(swapstring)
      await expect(swap.executeSwap(approved('wdk-bad'))).rejects.toMatchObject({
        code: 'SWAPSTRING_MISMATCH',
      })
      expect(calls.whitelisted).toEqual([])
      expect(calls.executed).toBe(0)
    },
  )

  it('refuses a swapstring when no swap is executing', async () => {
    const { swap, calls } = swapWith(GOOD)
    await expect((swap as any).guardedAccount().atomicTaker(GOOD)).rejects.toMatchObject({
      code: 'SWAPSTRING_MISMATCH',
    })
    expect(calls.whitelisted).toEqual([])
  })
})
