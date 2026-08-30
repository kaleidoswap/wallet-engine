import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'
import type { SwapQuote } from '../../src/types/base'

/**
 * Audit finding B-F2 — `executeSwap`'s expiry guard was
 * `if (quote.expiresAt > 0 && Date.now() > quote.expiresAt)`. `expiresAt` is
 * `quoteResponse.expires_at * 1000`, so a maker that omits or renames
 * `expires_at` yields `NaN`; `NaN > 0` is false, and the guard is skipped
 * entirely. A hostile or buggy maker could therefore switch OFF the engine's
 * only client-side expiry check simply by not sending the field.
 *
 * Note the amount guard immediately above it is already NaN-safe — written as
 * `!(quote.fromAmount > 0)` — so the two checks in the same function disagreed.
 */
function quote(over: Partial<SwapQuote>): SwapQuote {
  return {
    id: 'rfq-1', fromAsset: 'BTC', fromAmount: 1000, toAsset: 'USDT', toAmount: 1000,
    price: 1, fee: { amount: 0, asset: 'BTC', breakdown: { baseFee: 0, variableFee: 0, networkFee: 0 } },
    expiresAt: Date.now() + 60_000, provider: 'Kaleidoswap', ...over,
  } as SwapQuote
}

let initCalls = 0
beforeEach(() => {
  initCalls = 0
  ;(kaleidoClientManager as any).client = {
    maker: {
      initSwap: async () => { initCalls++; return { swapstring: 's', payment_hash: 'h', access_token: 't' } },
      executeSwap: async () => ({ status: 200 }),
    },
    rln: { whitelistSwap: async () => {}, getTakerPubkey: async () => 'pk' },
  }
})
afterEach(() => kaleidoClientManager.reset())

describe('B-F2: a non-finite quote expiry must fail closed', () => {
  const adapter = () => {
    const a = new RgbAdapter()
    Object.assign(a as any, { connected: true, config: { makerUrl: 'https://maker.invalid' } })
    return a
  }

  it('NaN expiresAt is rejected, not treated as "no expiry"', async () => {
    await expect(adapter().executeSwap(quote({ expiresAt: NaN })))
      .rejects.toThrow(/expir/i)
    expect(initCalls, 'must not reach the maker').toBe(0)
  })

  it('undefined / missing expiresAt is rejected', async () => {
    await expect(adapter().executeSwap(quote({ expiresAt: undefined as any })))
      .rejects.toThrow(/expir/i)
    expect(initCalls).toBe(0)
  })

  it('an actually-expired quote is still rejected', async () => {
    await expect(adapter().executeSwap(quote({ expiresAt: Date.now() - 1000 })))
      .rejects.toThrow(/expired/i)
    expect(initCalls).toBe(0)
  })

  it('a valid unexpired quote still executes', async () => {
    const r = await adapter().executeSwap(quote({}))
    expect(r.paymentHash).toBe('h')
    expect(initCalls).toBe(1)
  })
})
