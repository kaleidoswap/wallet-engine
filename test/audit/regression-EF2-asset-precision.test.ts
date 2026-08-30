import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'

/**
 * Audit finding E-F2 — `RgbAdapter.getAssetBalance()` called
 * `convertSdkBalance(balanceData)` with no precision argument, so the default
 * `precision = 8` (rgb-converters.ts:54, the BTC convention) was applied to
 * EVERY RGB asset. A precision-0 asset holding 1,000,000 units reported
 * "0.01000000" — understated by 1e8 — while `listAssets()` rendered the same
 * asset correctly, so the asset card and the balance call disagreed.
 *
 * This is the bug class commit 7fa23ce ("format balances at asset precision")
 * set out to fix; this call site was missed.
 */
const state = { client: null as any }
vi.mock('../../src/lib/kaleido-client-manager', () => ({
  kaleidoClientManager: { hasNode: () => true, getClient: () => state.client, reset: () => {} },
}))

function adapter() {
  const a = new RgbAdapter()
  Object.assign(a as any, { connected: true, config: {} })
  return a
}
function nodeWith(precision: number, settled: number, spendable = settled) {
  state.client = {
    rln: {
      getAssetBalance: async () => ({ settled, spendable, future: settled, offchain_outbound: 0, offchain_inbound: 0 }),
      getAssetMetadata: async () => ({ precision, ticker: 'TEST', name: 'Test', asset_id: 'rgb:test' }),
    },
  }
}

describe('E-F2: an RGB balance must render at the asset\'s own precision', () => {
  it('a precision-0 asset is not divided by 1e8', async () => {
    nodeWith(0, 1_000_000)
    const b = await adapter().getAssetBalance('rgb:test')
    expect(b.totalDisplay).toBe('1000000')
    expect(b.availableDisplay).toBe('1000000')
  })

  it('a precision-2 stablecoin renders as currency', async () => {
    nodeWith(2, 10_050)
    const b = await adapter().getAssetBalance('rgb:test')
    expect(b.totalDisplay, '10050 units at precision 2 is 100.50').toBe('100.50')
  })

  it('a precision-8 asset is unchanged', async () => {
    nodeWith(8, 100_000_000)
    const b = await adapter().getAssetBalance('rgb:test')
    expect(b.totalDisplay).toBe('1.00000000')
  })

  it('raw integer fields are untouched by the display precision', async () => {
    nodeWith(0, 1_000_000)
    const b = await adapter().getAssetBalance('rgb:test')
    expect(b.total).toBe(1_000_000)
    expect(b.available).toBe(1_000_000)
  })

  it('BTC still goes through the vanilla-only BTC path', async () => {
    state.client = { rln: { getBtcBalance: async () => ({ vanilla: { settled: 5000, future: 5000, spendable: 5000 } }) } }
    const b = await adapter().getAssetBalance('BTC')
    expect(b.totalDisplay).toBe('0.00005000')
  })
})
