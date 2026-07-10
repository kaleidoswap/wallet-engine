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

  it('throws when a money field is negative', async () => {
    const swap = swapWithQuoteResponse({
      rfqId: 'r1',
      tokenInAmount: 100,
      tokenOutAmount: 5000,
      price: 50,
      fee: -1, // a hostile/buggy maker returning a negative fee
      expiresAt: 1700000000,
    })
    await expect(swap.getQuote(REQ as any)).rejects.toThrow(/negative/i)
  })

  it('still requires fromAmount', async () => {
    const swap = swapWithQuoteResponse({})
    await expect(swap.getQuote({ ...REQ, fromAmount: undefined } as any)).rejects.toThrow(/fromAmount/i)
  })
})

/**
 * Quote binding (M1): the swap module re-quotes internally and executes at
 * THAT price — the approved quote is never enforced server-side. executeSwap
 * must enforce it client-side: expiry before ordering, slippage after.
 */
function swapWithSwapResponse(r: any) {
  const swap = new KaleidoswapSwap({} as any, { baseUrl: 'http://localhost' })
  ;(swap as any).proto = { swap: async () => r }
  return swap
}

const FILL = { orderId: 'o1', tokenInAmount: 100, tokenOutAmount: 5000, fee: 1 }
const APPROVED = {
  id: 'r1',
  fromAsset: REQ.fromAsset,
  fromAmount: 100,
  toAsset: REQ.toAsset,
  toAmount: 5000,
  price: 50,
  fee: { amount: 1, asset: REQ.fromAsset },
  expiresAt: Date.now() + 60_000,
  provider: 'kaleidoswap' as const,
}
const EXEC_REQ = { ...REQ, receiverAddress: 'rgb:inv', receiverAddressFormat: 'RGB_INVOICE' }

describe('KaleidoswapSwap.executeSwap quote binding', () => {
  it('executes when the fill matches the approved quote', async () => {
    const swap = swapWithSwapResponse(FILL)
    const r = await swap.executeSwap({ ...EXEC_REQ, approvedQuote: APPROVED } as any)
    expect(r.swapId).toBe('o1')
    expect(r.quote.toAmount).toBe(5000)
  })

  it('rejects before ordering when the approved quote has expired', async () => {
    let ordered = false
    const swap = new KaleidoswapSwap({} as any, { baseUrl: 'http://localhost' })
    ;(swap as any).proto = { swap: async () => ((ordered = true), FILL) }
    await expect(
      swap.executeSwap({ ...EXEC_REQ, approvedQuote: { ...APPROVED, expiresAt: Date.now() - 1000 } } as any),
    ).rejects.toThrow(/expired/i)
    expect(ordered).toBe(false)
  })

  it('rejects a fill degraded past the slippage tolerance (default 1%)', async () => {
    const swap = swapWithSwapResponse({ ...FILL, tokenOutAmount: 4900 }) // -2%
    await expect(swap.executeSwap({ ...EXEC_REQ, approvedQuote: APPROVED } as any)).rejects.toThrow(/degraded/i)
  })

  it('accepts a fill within the slippage tolerance', async () => {
    const swap = swapWithSwapResponse({ ...FILL, tokenOutAmount: 4960 }) // -0.8%
    const r = await swap.executeSwap({ ...EXEC_REQ, approvedQuote: APPROVED } as any)
    expect(r.quote.toAmount).toBe(4960)
  })

  it('honors a caller-supplied maxSlippageBps', async () => {
    const swap = swapWithSwapResponse({ ...FILL, tokenOutAmount: 4960 }) // -0.8%
    await expect(
      swap.executeSwap({ ...EXEC_REQ, approvedQuote: APPROVED, maxSlippageBps: 50 } as any),
    ).rejects.toThrow(/degraded/i)
  })

  it('accepts a better-than-quoted fill', async () => {
    const swap = swapWithSwapResponse({ ...FILL, tokenOutAmount: 5100 })
    const r = await swap.executeSwap({ ...EXEC_REQ, approvedQuote: APPROVED } as any)
    expect(r.quote.toAmount).toBe(5100)
  })

  it('remains backward-compatible without an approved quote', async () => {
    const swap = swapWithSwapResponse({ ...FILL, tokenOutAmount: 1 })
    const r = await swap.executeSwap(EXEC_REQ as any)
    expect(r.quote.toAmount).toBe(1)
  })
})
