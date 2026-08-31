/*
 * Regression test for audit finding E-F4 (REPORT.md §2.2, REPORT-2.md §4.2).
 *
 * `RgbAdapter.getSwapQuote` had none of the fail-closed money coercion
 * `KaleidoswapSwap` applies to the SAME maker API. The two paths consume the
 * same responses; one rejected a negative `final_fee`, a >2^53 amount and a
 * missing `price`/`expires_at`, and the other took every field raw off the wire
 * and fed it to `executeSwap`. SECURITY.md's "guarded at SDK boundaries" claim
 * was true of exactly one of them.
 *
 * The coercion is now one shared function, `src/lib/swap-money.ts`
 * `toSwapAmount`, extracted from `KaleidoswapSwap` and imported by both — so
 * they cannot drift apart again.
 *
 * SCOPE — this is a PORT, not new validation. Nothing here compares the maker's
 * amounts or asset ids to what the user requested; `fromAsset`/`toAsset` still
 * come from the maker's response on the native path. That is finding B-F1 and
 * needs a product decision. The last case below pins that boundary so a future
 * reader can see it was left open deliberately rather than missed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'
import { toSwapAmount } from '../../src/lib/swap-money'

afterEach(() => vi.restoreAllMocks())

const REQ = { fromAsset: 'rgb:USDT', toAsset: 'BTC', fromAmount: 1000 } as never

/** A well-formed maker quote response, with `over` merged in. */
function quoteResponse(over: Record<string, unknown> = {}) {
  return {
    rfq_id: 'rfq-1',
    from_asset: { asset_id: 'rgb:USDT', amount: 1000 },
    to_asset: { asset_id: 'BTC', amount: 5000 },
    price: 5,
    fee: { final_fee: 10, fee_asset: 'BTC', base_fee: 10, variable_fee: 0 },
    expires_at: 1_900_000_000,
    ...over,
  }
}

function adapterFor(response: unknown): RgbAdapter {
  const a = new RgbAdapter()
  Object.assign(a as any, {
    connected: true,
    config: { protocol: 'RGB_LN', network: 'regtest', makerUrl: 'https://maker.example' },
  })
  vi.spyOn(kaleidoClientManager, 'hasNode').mockReturnValue(true)
  vi.spyOn(kaleidoClientManager, 'isInitialized').mockReturnValue(true)
  vi.spyOn(kaleidoClientManager, 'getClient').mockReturnValue({
    maker: { getQuote: async () => response },
  } as never)
  return a
}

describe('E-F4: RgbAdapter.getSwapQuote applies the maker money coercion', () => {
  it('accepts a well-formed quote unchanged', async () => {
    const q = await adapterFor(quoteResponse()).getSwapQuote(REQ)
    expect(q.id).toBe('rfq-1')
    expect(q.fromAmount).toBe(1000)
    expect(q.toAmount).toBe(5000)
    expect(q.price).toBe(5)
    expect(q.fee.amount).toBe(10)
    expect(q.fee.breakdown?.baseFee).toBe(10)
    // Maker reports seconds; the engine convention is ms. Unchanged.
    expect(q.expiresAt).toBe(1_900_000_000 * 1000)
  })

  // Every money field on the response, and how it fails.
  const REJECTED: ReadonlyArray<[string, Record<string, unknown>, RegExp]> = [
    ['a negative final_fee', { fee: { final_fee: -1000, fee_asset: 'BTC', base_fee: 0, variable_fee: 0 } }, /negative/i],
    ['a negative base_fee', { fee: { final_fee: 1, fee_asset: 'BTC', base_fee: -1, variable_fee: 0 } }, /negative/i],
    ['a negative variable_fee', { fee: { final_fee: 1, fee_asset: 'BTC', base_fee: 0, variable_fee: -1 } }, /negative/i],
    ['a negative price', { price: -20 }, /negative/i],
    ['a negative from-leg amount', { from_asset: { asset_id: 'rgb:USDT', amount: -1 } }, /negative/i],
    ['a from-leg amount past 2^53', { from_asset: { asset_id: 'rgb:USDT', amount: '9007199254740993' } }, /safe integer precision/i],
    ['a to-leg amount past 2^53', { to_asset: { asset_id: 'BTC', amount: '9007199254740993' } }, /safe integer precision/i],
    ['a missing price', { price: undefined }, /not a finite number/i],
    ['a missing expires_at', { expires_at: undefined }, /not a finite number/i],
    ['a missing from-leg amount', { from_asset: { asset_id: 'rgb:USDT' } }, /not a finite number/i],
    ['a non-numeric amount', { to_asset: { asset_id: 'BTC', amount: 'plenty' } }, /not a finite number/i],
    ['a missing fee object', { fee: undefined }, /not a finite number/i],
  ]

  for (const [name, over, message] of REJECTED) {
    it(`rejects ${name}`, async () => {
      await expect(adapterFor(quoteResponse(over)).getSwapQuote(REQ)).rejects.toThrow(message)
    })
  }

  it('a missing amount is refused, not defaulted to 0', async () => {
    // The old `Number(x || 0)` turned an absent leg amount into a zero-amount
    // quote. A counterparty must not be able to switch off a safety check by
    // leaving a field out — the same rationale as the executeSwap expiry guard.
    await expect(
      adapterFor(quoteResponse({ from_asset: { asset_id: 'rgb:USDT' } })).getSwapQuote(REQ),
    ).rejects.toThrow(/from_asset\.amount/)
  })

  it('is the same function the WDK path uses, not a copy', async () => {
    // The two paths drifting apart IS the finding. One module, both importers.
    expect(() => toSwapAmount(-1, 'x')).toThrow(/negative/i)
    expect(() => toSwapAmount(Number.MAX_SAFE_INTEGER + 2, 'x')).toThrow(/safe integer/i)
    expect(() => toSwapAmount(undefined, 'x')).toThrow(/not a finite number/i)
    expect(toSwapAmount('1000', 'x')).toBe(1000)
    expect(toSwapAmount(0, 'x')).toBe(0)
  })

  it('getSwapStatus coerces too, and keeps its `?? 0` for an unfilled swap', async () => {
    const a = new RgbAdapter()
    Object.assign(a as any, {
      connected: true,
      config: { protocol: 'RGB_LN', network: 'regtest', makerUrl: 'https://maker.example' },
    })
    vi.spyOn(kaleidoClientManager, 'hasNode').mockReturnValue(true)
    vi.spyOn(kaleidoClientManager, 'isInitialized').mockReturnValue(true)
    const swap: Record<string, unknown> = { status: 'Waiting' }
    vi.spyOn(kaleidoClientManager, 'getClient').mockReturnValue({
      maker: { getAtomicSwapStatus: async () => swap },
    } as never)

    // A status lookup legitimately predates a fill: absent quantities are 0.
    const r = await a.getSwapStatus('sw-1')
    expect(r.quote.fromAmount).toBe(0)
    expect(r.quote.toAmount).toBe(0)

    // But a present, corrupt one still fails closed.
    swap.qty_from = -5
    await expect(a.getSwapStatus('sw-1')).rejects.toThrow(/negative/i)
  })

  it('B-F1 BOUNDARY: maker-authored asset ids are still echoed, deliberately', async () => {
    // Left open on purpose. The maker names the assets and nothing compares them
    // to `request.fromAsset` / `request.toAsset`. Whether the engine should
    // re-validate and fail closed is finding B-F1, a product decision that is
    // explicitly out of scope for the E-F4 port. If a future change closes it,
    // THIS case is the one to flip.
    const q = await adapterFor(
      quoteResponse({ from_asset: { asset_id: 'rgb:WORTHLESS', amount: 1000 } }),
    ).getSwapQuote(REQ)
    expect(q.fromAsset, 'still the maker\'s answer, not the request\'s').toBe('rgb:WORTHLESS')
  })
})
