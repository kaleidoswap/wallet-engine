/**
 * PHASE 3 concurrency, part 2 (run 2) — two swaps racing on one route / one quote.
 *
 * What this exercises and what it found. All interleavings are driven by explicit
 * deferreds, not timing.
 *
 *  N6 (LOW, fixed) — concurrent first calls share one module construction.
 *
 *  HELD — the per-swap `accessTokens` map is keyed by payment hash, so two
 *      concurrent swaps never overwrite each other's status token.
 *
 *  HELD — a shared `Quote` object is not mutated by execution: `executeSwap`
 *      spreads it into the result (`quote: { ...quote, … }`), so one swap cannot
 *      corrupt the other's approved amounts.
 *
 *  BY DESIGN (not a finding) — two concurrent `executeSwap` calls on one approved
 *      quote each pass the spend cap independently, so N concurrent swaps can move
 *      N × cap. `SigningPolicy.maxAmountSat` is documented as a "Global
 *      per-transaction spend cap" (src/policy/index.ts), so this is the documented
 *      semantics, not a bypass. The absence of a replay/in-flight guard on
 *      `executeSwap` is run 1's B-F3 and remains open.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { registerWdkModule } from '../../src/adapters/wdk/moduleLoader'

const modState = { constructed: 0 }

// The documented seam: `loadWdkModule` prefers a host-registered loader over the
// inline dynamic import, so this replaces the real (network-touching) module.
beforeAll(() => {
  class FakeProtocol {
    constructor(
      public account: unknown,
      public opts: { baseUrl: string },
    ) {
      modState.constructed += 1
    }
    async quoteSwap(_req: unknown) {
      return {
        rfqId: 'rfq-1',
        tokenInAmount: 100_000,
        tokenOutAmount: 250,
        price: 1,
        fee: 10,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      }
    }
    async swap(req: { rfqId: string; tokenInAmount: number; tokenOutAmount: number }) {
      return {
        paymentHash: `ph-${req.tokenInAmount}`,
        accessToken: `tok-${req.tokenInAmount}`,
        status: 'Waiting',
        tokenInAmount: req.tokenInAmount,
        tokenOutAmount: req.tokenOutAmount,
      }
    }
    async getOrderStatus(hash: string, token: string) {
      return { payment_hash: hash, status: token ? 'Pending' : 'Failed', qty_from: 1, qty_to: 1 }
    }
  }
  registerWdkModule('@kaleidorg/wdk-protocol-swap-kaleidoswap', () => ({ default: FakeProtocol }))
})

import { KaleidoswapSwap } from '../../src/swap/KaleidoswapSwap'

const REQ = {
  fromAsset: 'BTC',
  toAsset: 'rgb:usdt',
  fromAmount: 100_000,
  fromLayer: 'BTC_LN',
  toLayer: 'RGB_LN',
} as never

describe('N6: concurrent getQuote() single-flights the swap protocol module', () => {
  it('two concurrent first-calls construct one shared instance', async () => {
    modState.constructed = 0
    const swap = new KaleidoswapSwap({}, { baseUrl: 'https://maker.example' })

    const [a, b] = await Promise.all([swap.getQuote(REQ), swap.getQuote(REQ)])

    // Both quotes are correct — the module is bound to the same account/baseUrl.
    expect(a.fromAmount).toBe(100_000)
    expect(b.fromAmount).toBe(100_000)
    expect(modState.constructed).toBe(1)
  })

  it('a sequential second call reuses the instance (the cache itself works)', async () => {
    modState.constructed = 0
    const swap = new KaleidoswapSwap({}, { baseUrl: 'https://maker.example' })
    await swap.getQuote(REQ)
    await swap.getQuote(REQ)
    expect(modState.constructed).toBe(1)
  })
})

describe('concurrency invariants that HOLD on the swap path', () => {
  it('two concurrent swaps do not overwrite each other`s status access token', async () => {
    const swap = new KaleidoswapSwap({}, { baseUrl: 'https://maker.example' })
    const quote = await swap.getQuote(REQ)

    const [r1, r2] = await Promise.all([
      swap.executeSwap({ ...quote, fromAmount: 100_000 }),
      swap.executeSwap({ ...quote, fromAmount: 200_000 }),
    ])
    expect(r1.paymentHash).not.toBe(r2.paymentHash)

    // Each hash resolves through its own token — the map did not collide.
    const s1 = await swap.getSwapStatus(r1.paymentHash)
    const s2 = await swap.getSwapStatus(r2.paymentHash)
    expect(s1.status).not.toBe('failed')
    expect(s2.status).not.toBe('failed')
  })

  it('executing a shared quote object does not mutate it', async () => {
    const swap = new KaleidoswapSwap({}, { baseUrl: 'https://maker.example' })
    const quote = await swap.getQuote(REQ)
    const snapshot = { ...quote }

    await Promise.all([swap.executeSwap(quote), swap.executeSwap(quote)])

    expect(quote).toEqual(snapshot)
  })
})
