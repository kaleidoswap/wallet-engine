/*
 * FIXED — this is now the finding's regression test (run 2, REPORT-2.md).
 *
 * It was landed by run 1 as a committed `describe.skip`ped reproduction of a
 * confirmed-but-unfixed finding. Run 2 verified the claim against the contract,
 * fixed the code, and removed the `.skip` — so this file now fails if the finding
 * regresses. The commit that removed the `.skip` records the failing output at its
 * parent.
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
