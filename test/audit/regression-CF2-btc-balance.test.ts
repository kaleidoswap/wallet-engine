import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'

const state = { client: null as any }
vi.mock('../../src/lib/kaleido-client-manager', () => ({
  kaleidoClientManager: {
    hasNode: () => true,
    isInitialized: () => true,
    getClient: () => state.client,
    reset: () => {},
  },
}))

/**
 * Audit finding C-F2 — one adapter, two contradictory BTC balances.
 *
 * `convertBtcBalance` (rgb-converters.ts:28-45) states the policy in its own doc
 * comment: "colored sats are accounted for under each RGB asset's own balance.
 * Locks the policy: don't show colored sats as spendable BTC." — and returns the
 * vanilla portion only. `RgbAdapter.getBtcBalance()` summed vanilla + colored,
 * so the same adapter reported 5000 via `getAssetBalance('BTC')` and 7000 via
 * `getBtcBalance()` for identical node state. Colored sats sit under RGB asset
 * allocations and cannot be spent as ordinary BTC, so the overstated figure is
 * what a host would use to bound a send or a "max" button.
 */
const NODE_STATE = {
  vanilla: { settled: 5000, future: 5000, spendable: 5000 },
  colored: { settled: 2000, future: 2000, spendable: 2000 },
}

function adapter() {
  const a = new RgbAdapter()
  Object.assign(a as any, { connected: true, config: {} })
  return a
}

beforeEach(() => {
  state.client = { rln: { getBtcBalance: async () => NODE_STATE } }
})

describe('C-F2: BTC balance must exclude RGB-colored sats', () => {
  it('getBtcBalance() and getAssetBalance("BTC") agree', async () => {
    const a = adapter()
    const assetView = await a.getAssetBalance('BTC')
    const btcView = await a.getBtcBalance()
    expect(assetView.total).toBe(5000)
    expect(btcView.confirmed, 'colored sats are not spendable BTC').toBe(5000)
    expect(btcView.total, 'one adapter must not give two answers').toBe(5000)
  })

  it('pending vanilla BTC still surfaces as unconfirmed', async () => {
    state.client = { rln: { getBtcBalance: async () => ({
      vanilla: { settled: 5000, future: 8000, spendable: 5000 },
      colored: { settled: 2000, future: 2000, spendable: 2000 },
    }) } }
    const btcView = await adapter().getBtcBalance()
    expect(btcView.confirmed).toBe(5000)
    expect(btcView.unconfirmed, '3000 sats inbound').toBe(3000)
    expect(btcView.total).toBe(8000)
  })

  // C-F4b (run 2): the C-F2 fix aligned the two BTC views on which sats count,
  // but not on which bucket is the TOTAL. `getBtcBalance()` uses `future`;
  // `convertBtcBalance` used `settled`, so with an unconfirmed receive in flight
  // one adapter still gave two answers — 8000 vs 5000 — and the asset view hid
  // the incoming 3000 entirely.
  it('the two BTC views also agree while a receive is unconfirmed', async () => {
    state.client = { rln: { getBtcBalance: async () => ({
      vanilla: { settled: 5000, future: 8000, spendable: 5000 },
      colored: { settled: 2000, future: 2000, spendable: 2000 },
    }) } }
    const a = adapter()
    const assetView = await a.getAssetBalance('BTC')
    const btcView = await a.getBtcBalance()
    expect(assetView.total, 'one adapter must not give two answers').toBe(btcView.total)
    expect(assetView.total).toBe(8000)
    expect(assetView.pending, 'the unsettled delta, not the projected total').toBe(3000)
  })

  it('a node with no colored sub-balance still works', async () => {
    state.client = { rln: { getBtcBalance: async () => ({ vanilla: { settled: 1000, future: 1000, spendable: 1000 } }) } }
    const btcView = await adapter().getBtcBalance()
    expect(btcView).toEqual({ confirmed: 1000, unconfirmed: 0, total: 1000 })
  })
})
