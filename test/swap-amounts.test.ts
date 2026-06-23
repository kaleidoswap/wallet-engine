import { describe, it, expect } from 'vitest'
import { KaleidoswapSwap } from '../src/swap/KaleidoswapSwap'

/**
 * Money fields coming back from the swap module must fail CLOSED on values that
 * would silently corrupt (missing/renamed field → NaN, or magnitude past
 * Number.MAX_SAFE_INTEGER). See S4.
 */
function swapWithQuoteResponse(q: any) {
  const swap = new KaleidoswapSwap({} as any, { baseUrl: 'http://localhost' })
  // Inject a fake proto so ensure() short-circuits.
  ;(swap as any).proto = { quoteSwap: async () => q }
  return swap
}

const REQ = {
  fromAsset: 'rgb:USDT',
  toAsset: 'BTC',
  fromLayer: 'RGB_LN',
  toLayer: 'BTC_LN',
  fromAmount: 100,
}

describe('KaleidoswapSwap.getQuote amount guards', () => {
  it('maps a well-formed quote', async () => {
    const swap = swapWithQuoteResponse({
      rfqId: 'r1',
      tokenInAmount: 100,
      tokenOutAmount: 5000,
      price: 50,
      fee: 1,
      expiresAt: 1700000000,
    })
    const q = await swap.getQuote(REQ as any)
    expect(q.fromAmount).toBe(100)
    expect(q.toAmount).toBe(5000)
    expect(q.price).toBe(50)
    expect(q.expiresAt).toBe(1700000000 * 1000)
  })

  it('throws when a money field is missing (would be NaN)', async () => {
    const swap = swapWithQuoteResponse({ rfqId: 'r1', tokenOutAmount: 5000, price: 50, fee: 1, expiresAt: 1 })
    await expect(swap.getQuote(REQ as any)).rejects.toThrow(/not a finite number/i)
  })

  it('throws when an amount exceeds safe integer precision', async () => {
    const swap = swapWithQuoteResponse({
      rfqId: 'r1',
      tokenInAmount: '9007199254740993', // MAX_SAFE_INTEGER + 2
      tokenOutAmount: 5000,
      price: 50,
      fee: 1,
      expiresAt: 1,
    })
    await expect(swap.getQuote(REQ as any)).rejects.toThrow(/safe integer precision/i)
  })

  it('still requires fromAmount', async () => {
    const swap = swapWithQuoteResponse({})
    await expect(swap.getQuote({ ...REQ, fromAmount: undefined } as any)).rejects.toThrow(/fromAmount/i)
  })
})
