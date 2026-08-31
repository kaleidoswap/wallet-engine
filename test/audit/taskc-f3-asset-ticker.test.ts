/*
 * OPEN FINDING — reproduction, not yet fixed.
 *
 * `describe.skip` so the branch stays green: these assert the behaviour the
 * code SHOULD have. Remove the `.skip` when the finding is fixed and they
 * become its regression test. See REPORT.md for the finding this belongs to.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'

/**
 * AUDIT C-F3 — RgbAdapter.getAsset resolves by TICKER as well as asset id
 * (src/adapters/RgbAdapter.ts:251: `a.id === assetId || a.ticker === assetId`).
 *
 * RGB tickers/names are issuer-controlled free text. A malicious issuer can
 * issue a lookalike asset with ticker "USDT"; if the node lists it before the
 * genuine USDT asset, `getAsset('USDT')` returns the impostor — its id is then
 * used by any flow that resolves an asset by the ticker the user typed/saw.
 * Asset identity in RGB is the asset_id (contract id) ONLY; a ticker must never
 * resolve to an asset.
 */
function fakeClientWithAssets(nia: any[]) {
  return {
    rln: {
      listAssets: async () => ({ nia, uda: [], cfa: [] }),
    },
  }
}

describe('AUDIT C-F3: getAsset ticker collision', () => {
  afterEach(() => vi.restoreAllMocks())

  it('a lookalike issuer ticker must not resolve via getAsset', async () => {
    const impostor = {
      asset_id: 'rgb:impostor-contract-id',
      name: 'Tether USD',
      ticker: 'USDT', // issuer-controlled free text
      precision: 6,
      balance: { settled: 1_000_000_000, spendable: 1_000_000_000, future: 1_000_000_000 },
    }
    const genuine = {
      asset_id: 'rgb:2dkSTbr-genuine-usdt',
      name: 'Tether USD',
      ticker: 'USDT',
      precision: 6,
      balance: { settled: 50, spendable: 50, future: 50 },
    }
    // Node happens to list the impostor first.
    vi.spyOn(kaleidoClientManager, 'isInitialized').mockReturnValue(true)
    vi.spyOn(kaleidoClientManager, 'hasNode').mockReturnValue(true)
    vi.spyOn(kaleidoClientManager, 'getClient').mockReturnValue(
      fakeClientWithAssets([impostor, genuine]) as any,
    )

    const adapter = new RgbAdapter()
    Object.assign(adapter as any, { connected: true, config: { protocol: 'RGB_LN', network: 'mainnet' } })

    // A ticker is not an asset identity: this lookup must fail (or at minimum
    // never return the impostor). It currently returns the impostor.
    await expect(adapter.getAsset('USDT')).rejects.toThrow()
  })
})
