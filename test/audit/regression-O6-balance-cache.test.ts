import { beforeEach, describe, expect, it } from 'vitest'
import {
  getSparkBalanceCached,
  invalidateSparkBalanceCache,
  _resetSparkBalanceCacheForTests,
} from '../../src/lib/spark-balance-cache'

/**
 * Audit finding O6 — the generation counter stopped a pre-invalidation snapshot
 * from being WRITTEN to the cache, but not from being RETURNED. Any reader
 * arriving while a stale fetch was in flight got handed that fetch's promise
 * (spark-balance-cache.ts:91), i.e. exactly the value the code calls "already
 * stale and must not become the served value" (lines 97-99). After a send, a
 * concurrent balance read reported the spent sats as still available.
 */
function deferredWallet() {
  const resolvers: Array<(v: any) => void> = []
  const w = { getBalance: () => new Promise<any>((r) => resolvers.push(r)) } as any
  return {
    w,
    calls: () => resolvers.length,
    settle: (i: number, sats: bigint) => resolvers[i]({ balance: sats, tokenBalances: new Map() }),
  }
}

beforeEach(() => _resetSparkBalanceCacheForTests())

describe('O6: an invalidation must not be undone by an in-flight fetch', () => {
  it('a read after invalidateSparkBalanceCache() does not get the pre-send balance', async () => {
    const { w, calls, settle } = deferredWallet()

    const before = getSparkBalanceCached(w)   // pre-send fetch starts
    invalidateSparkBalanceCache()             // a send completes
    const after = getSparkBalanceCached(w)    // concurrent read

    expect(calls(), 'the post-invalidation read must not reuse the stale fetch').toBe(2)
    settle(0, 100_000n)                       // stale, pre-send
    settle(1, 40_000n)                        // fresh, post-send
    expect((await before).balance).toBe(100_000n)
    expect((await after).balance, 'must see the post-send balance').toBe(40_000n)
  })

  it('concurrent readers with no invalidation still share ONE rpc', async () => {
    const { w, calls, settle } = deferredWallet()
    const a = getSparkBalanceCached(w)
    const b = getSparkBalanceCached(w)
    expect(calls(), 'coalescing must survive the fix').toBe(1)
    settle(0, 7n)
    expect((await a).balance).toBe(7n)
    expect((await b).balance).toBe(7n)
  })

  it('a settled value is still cached and reused within the TTL', async () => {
    const { w, calls, settle } = deferredWallet()
    const first = getSparkBalanceCached(w)
    settle(0, 5_000n)
    await first
    await getSparkBalanceCached(w)
    expect(calls(), 'second read inside the TTL is served from cache').toBe(1)
  })
})
