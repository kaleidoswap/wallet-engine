import { describe, it, expect, beforeEach } from 'vitest'
import {
  getSparkBalanceCached,
  invalidateSparkBalanceCache,
  _resetSparkBalanceCacheForTests,
} from '../src/lib/spark-balance-cache'

/** Minimal wallet stub exposing just the `getBalance` the cache calls. */
function walletReturning(balance: bigint) {
  return { getBalance: async () => ({ balance, tokenBalances: new Map() }) } as any
}

describe('spark balance cache', () => {
  beforeEach(() => _resetSparkBalanceCacheForTests())

  it('coalesces repeated reads for the same wallet within the TTL', async () => {
    let calls = 0
    const wallet = {
      getBalance: async () => {
        calls++
        return { balance: 500n, tokenBalances: new Map() }
      },
    } as any
    await getSparkBalanceCached(wallet)
    await getSparkBalanceCached(wallet)
    expect(calls).toBe(1)
  })

  it('never serves one wallet\'s balance to a different wallet instance', async () => {
    const a = await getSparkBalanceCached(walletReturning(111n))
    expect(a.balance).toBe(111n)
    // A different instance is a hard cache miss — must not reuse 111n.
    const b = await getSparkBalanceCached(walletReturning(222n))
    expect(b.balance).toBe(222n)
  })

  it('does not repopulate the cache from a fetch invalidated mid-flight', async () => {
    let resolveFirst!: (v: unknown) => void
    let calls = 0
    const wallet = {
      getBalance: () => {
        calls++
        if (calls === 1) return new Promise((res) => { resolveFirst = res })
        return Promise.resolve({ balance: 200n, tokenBalances: new Map() })
      },
    } as any

    const inflight = getSparkBalanceCached(wallet) // fetch #1 starts, in flight
    invalidateSparkBalanceCache() // a send/receive completes mid-flight
    resolveFirst({ balance: 100n, tokenBalances: new Map() }) // pre-mutation snapshot

    // The original caller still receives its value...
    expect((await inflight).balance).toBe(100n)
    // ...but the stale snapshot must NOT have been cached: the next read re-fetches.
    const next = await getSparkBalanceCached(wallet)
    expect(next.balance).toBe(200n)
    expect(calls).toBe(2)
  })
})
