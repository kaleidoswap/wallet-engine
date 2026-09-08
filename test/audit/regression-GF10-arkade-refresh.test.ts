/**
 * AUDIT G-F10 — `ArkadeAdapter.refreshBalances()` was an empty no-op whose comment
 * claimed "Balances are fetched live on each call".
 *
 * That comment is false: every balance/VTXO read goes through the shared 3-second
 * snapshot cache (`getArkadeBalanceCached`/`getArkadeVtxosCached`), and only SENDS
 * invalidated it. So a pull-to-refresh after a deposit resolved successfully — the
 * UI showed "refreshed" — over the same stale snapshot, for up to the TTL.
 *
 * `ProtocolManager.refreshBalances`' own JSDoc states the intent: "Invalidate every
 * connected adapter's balance cache so the next read is fresh."
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArkadeAdapter } from '../../src/adapters/ArkadeAdapter'
import { arkadeClientManager } from '../../src/lib/arkade-client-manager'
import { _resetArkadeSnapshotCacheForTests } from '../../src/lib/arkade-snapshot-cache'

const state = { balanceFetches: 0 }

function connectedAdapter() {
  const adapter = new ArkadeAdapter()
  const wallet = {
    getBalance: async () => {
      state.balanceFetches += 1
      return { total: 5000, settled: 5000, available: 5000, boarding: { total: 0 } }
    },
    getVtxos: async () => [],
  }
  vi.spyOn(arkadeClientManager, 'isInitialized').mockReturnValue(true)
  vi.spyOn(arkadeClientManager, 'getWallet').mockReturnValue(wallet as never)
  Object.assign(adapter as never, { config: { protocol: 'ARKADE', network: 'signet' } })
  return adapter
}

beforeEach(() => {
  state.balanceFetches = 0
  _resetArkadeSnapshotCacheForTests()
})
afterEach(() => vi.restoreAllMocks())

describe('G-F10: ArkadeAdapter.refreshBalances must invalidate the snapshot cache', () => {
  it('a read after refreshBalances() hits the provider again', async () => {
    const adapter = connectedAdapter()

    await adapter.getBtcBalance()
    expect(state.balanceFetches, 'first read fetches').toBe(1)

    // Within the 3s TTL a second read is served from the snapshot — that part is
    // deliberate and must not change.
    await adapter.getBtcBalance()
    expect(state.balanceFetches, 'cached within TTL').toBe(1)

    // …but an explicit refresh must drop it.
    await adapter.refreshBalances()
    await adapter.getBtcBalance()
    expect(state.balanceFetches, 'refreshBalances() invalidated the snapshot').toBe(2)
  })
})
