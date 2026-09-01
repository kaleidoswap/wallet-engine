import { describe, it, expect } from 'vitest'
import { KaleidoswapSwap } from '../src/swap/KaleidoswapSwap'

/**
 * Money fields from the swap module must fail CLOSED on values that would silently
 * corrupt (missing/renamed field → NaN, or magnitude past Number.MAX_SAFE_INTEGER).
 * See S4.
 *
 * UNITS: raw base units throughout — the quote's amounts pass straight through to
 * execution, so there is no display/raw conversion here (that mismatch was
 * CVE-grade: audit C1).
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
  fromAmount: 100_000_000, // raw base units
}

describe('KaleidoswapSwap.getQuote amount guards', () => {
  it('maps a well-formed quote', async () => {
    const swap = swapWithQuoteResponse({
      rfqId: 'r1',
      tokenInAmount: 100_000_000,
      tokenOutAmount: 5000,
      price: 50,
      fee: 1,
      expiresAt: 1700000000,
    })
    const q = await swap.getQuote(REQ as any)
    expect(q.fromAmount).toBe(100_000_000)
    expect(q.toAmount).toBe(5000)
    expect(q.price).toBe(50)
    expect(q.expiresAt).toBe(1700000000 * 1000)
  })

  it('passes the raw fromAmount through to the module unchanged', async () => {
    let sent: any = null
    const swap = new KaleidoswapSwap({} as any, { baseUrl: 'http://localhost' })
    ;(swap as any).proto = {
      quoteSwap: async (opts: any) => {
        sent = opts
        return { rfqId: 'r1', tokenInAmount: REQ.fromAmount, tokenOutAmount: 1, price: 1, fee: 0, expiresAt: 1 }
      },
    }
    await swap.getQuote(REQ as any)
    expect(sent.fromAmount).toBe(100_000_000)
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
      tokenInAmount: REQ.fromAmount,
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
 * Quote binding: execution passes the approved quote's rfqId and exact raw amounts
 * to the maker, so there is no server-side re-quote and the fill cannot diverge from
 * the approval. executeSwap must refuse quotes that are expired or missing their
 * id/amounts.
 */
function swapWithSwapResponse(r: any) {
  const swap = new KaleidoswapSwap({} as any, { baseUrl: 'http://localhost' })
  ;(swap as any).proto = { swap: async () => r }
  return swap
}

const FILL = {
  paymentHash: 'ph1',
  swapstring: 'ss1',
  accessToken: 'tok1',
  status: 'Waiting',
  tokenInAmount: 100_000_000,
  tokenOutAmount: 5000,
}
const APPROVED = {
  id: 'r1',
  fromAsset: REQ.fromAsset,
  fromAmount: 100_000_000,
  toAsset: REQ.toAsset,
  toAmount: 5000,
  price: 50,
  fee: { amount: 1, asset: REQ.fromAsset },
  expiresAt: Date.now() + 60_000,
  provider: 'kaleidoswap' as const,
}

describe('KaleidoswapSwap.executeSwap quote binding', () => {
  it('executes the approved quote and surfaces the access token', async () => {
    const swap = swapWithSwapResponse(FILL)
    const r = await swap.executeSwap(APPROVED as any)
    expect(r.swapId).toBe('ph1')
    expect(r.paymentHash).toBe('ph1')
    expect(r.accessToken).toBe('tok1')
    expect(r.status).toBe('pending')
    expect(r.quote.fromAmount).toBe(100_000_000)
    expect(r.quote.toAmount).toBe(5000)
  })

  it('passes the rfq id and exact raw amounts to the module', async () => {
    let sent: any = null
    const swap = new KaleidoswapSwap({} as any, { baseUrl: 'http://localhost' })
    ;(swap as any).proto = { swap: async (opts: any) => ((sent = opts), FILL) }
    await swap.executeSwap(APPROVED as any)
    expect(sent).toEqual({
      rfqId: 'r1',
      fromAssetId: REQ.fromAsset,
      toAssetId: REQ.toAsset,
      tokenInAmount: 100_000_000,
      tokenOutAmount: 5000,
    })
  })

  it('rejects before ordering when the approved quote has expired', async () => {
    let ordered = false
    const swap = new KaleidoswapSwap({} as any, { baseUrl: 'http://localhost' })
    ;(swap as any).proto = { swap: async () => ((ordered = true), FILL) }
    await expect(
      swap.executeSwap({ ...APPROVED, expiresAt: Date.now() - 1000 } as any),
    ).rejects.toThrow(/expired/i)
    expect(ordered).toBe(false)
  })

  it('rejects a quote without an rfq id', async () => {
    const swap = swapWithSwapResponse(FILL)
    await expect(swap.executeSwap({ ...APPROVED, id: '' } as any)).rejects.toThrow(/rfq/i)
  })

  it('rejects a quote missing either amount', async () => {
    const swap = swapWithSwapResponse(FILL)
    await expect(swap.executeSwap({ ...APPROVED, fromAmount: 0 } as any)).rejects.toThrow(/amount/i)
    await expect(swap.executeSwap({ ...APPROVED, toAmount: NaN } as any)).rejects.toThrow(/amount/i)
  })
})

describe('KaleidoswapSwap.getSwapStatus', () => {
  function swapWithStatus(s: any, capture?: (args: any[]) => void) {
    const swap = new KaleidoswapSwap({} as any, { baseUrl: 'http://localhost' })
    ;(swap as any).proto = {
      swap: async () => FILL,
      getOrderStatus: async (...args: any[]) => {
        capture?.(args)
        return s
      },
    }
    return swap
  }

  it('maps atomic statuses fail-safe', async () => {
    const cases: Array<[string, string]> = [
      ['Succeeded', 'confirmed'],
      ['Failed', 'failed'],
      ['Expired', 'failed'],
      ['Waiting', 'pending'],
      ['Pending', 'pending'],
      ['SomethingNew', 'pending'],
    ]
    for (const [raw, mapped] of cases) {
      const swap = swapWithStatus({ payment_hash: 'ph1', status: raw, qty_from: 1, qty_to: 2 })
      const r = await swap.getSwapStatus('ph1')
      expect(r.status).toBe(mapped)
    }
  })

  it('reuses the access token captured at execution', async () => {
    let captured: any[] = []
    const swap = swapWithStatus({ payment_hash: 'ph1', status: 'Pending' }, (args) => (captured = args))
    await swap.executeSwap(APPROVED as any) // stores tok1 for ph1
    await swap.getSwapStatus('ph1')
    expect(captured).toEqual(['ph1', 'tok1'])
  })

  it('prefers a caller-supplied access token', async () => {
    let captured: any[] = []
    const swap = swapWithStatus({ payment_hash: 'ph1', status: 'Pending' }, (args) => (captured = args))
    await swap.getSwapStatus('ph1', 'tok-host')
    expect(captured).toEqual(['ph1', 'tok-host'])
  })
})
