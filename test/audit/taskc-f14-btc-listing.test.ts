import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * AUDIT C-F14 — RgbAdapter.listAssets() never includes BTC and hard-fails when
 * the wallet holds no RGB assets.
 *
 * src/adapters/RgbAdapter.ts:204-247 builds the unified asset list ONLY from
 * the node's nia/uda/cfa buckets, then throws NO_ASSETS_AVAILABLE when all
 * three are empty (lines 238-244). BTC is never added — unlike the WDK
 * adapters, which always prepend the BTC asset (RlnWdkAdapter.ts:212,
 * RgbLibWasmAdapter.ts:298 via RgbCore.rgbBtcAsset). Consequences:
 *  - a BTC-only wallet's `listAssets()` throws, breaking the unified balance
 *    view instead of showing the BTC balance;
 *  - even with RGB assets present, the unified asset inventory has no BTC
 *    entry, so `ProtocolManager.getAsset('BTC')` (which fans out to
 *    adapter.getAsset) can never resolve BTC on this adapter.
 */

const state = { client: null as any }
vi.mock('../../src/lib/kaleido-client-manager', () => ({
  kaleidoClientManager: {
    initialize: () => {},
    reset: () => {},
    isInitialized: () => true,
    hasNode: () => true,
    getClient: () => state.client,
  },
}))
import { RgbAdapter } from '../../src/adapters/RgbAdapter'

afterEach(() => {
  state.client = null
})

function connectedRgbAdapter() {
  const adapter = new RgbAdapter()
  Object.assign(adapter as any, {
    connected: true,
    config: { protocol: 'RGB_LN', makerUrl: '', nodeUrl: 'http://mock', network: 'regtest' },
  })
  return adapter
}

describe('AUDIT C-F14: RgbAdapter.listAssets omits BTC / throws on BTC-only wallets', () => {
  it('a wallet holding only BTC gets NO_ASSETS_AVAILABLE instead of a BTC asset entry', async () => {
    state.client = { rln: { listAssets: async () => ({ nia: [], uda: [], cfa: [] }) } }
    const adapter = connectedRgbAdapter()
    await expect(adapter.listAssets()).rejects.toThrow(/No wallet assets/)
  })

  it('even with RGB assets present, the unified list has no BTC entry', async () => {
    state.client = {
      rln: {
        listAssets: async () => ({
          nia: [{ asset_id: 'rgb:usdt', ticker: 'USDT', precision: 6, balance: { settled: 1 } }],
        }),
      },
    }
    const adapter = connectedRgbAdapter()
    const assets = await adapter.listAssets()
    expect(assets.map((a) => a.id)).not.toContain('BTC')
  })
})
