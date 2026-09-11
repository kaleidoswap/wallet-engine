/**
 * PHASE 3 concurrency (run 2) — the Arkade snapshot cache does NOT have the O6
 * defect that was fixed in the Spark balance cache (aac6ac6). Recorded so the next
 * audit need not re-derive it.
 *
 * O6 was: the generation counter stopped a pre-invalidation snapshot being WRITTEN
 * but not being RETURNED — a reader arriving after `invalidate…()` was handed the
 * in-flight (pre-send) promise and saw spent sats as available.
 *
 * `invalidateArkadeSnapshotCache()` nulls `inflightBalance`/`inflightVtxos` as well
 * as the entries, so a post-invalidation reader starts a FRESH fetch rather than
 * joining the stale one. Both halves are asserted below.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  getArkadeBalanceCached,
  invalidateArkadeSnapshotCache,
  _resetArkadeSnapshotCacheForTests,
} from '../../src/lib/arkade-snapshot-cache'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => _resetArkadeSnapshotCacheForTests())

describe('arkade snapshot cache vs a mid-flight invalidation (the O6 shape)', () => {
  it('a reader arriving AFTER an invalidation is not served the pre-invalidation fetch', async () => {
    const first = deferred<{ total: number }>()
    const second = deferred<{ total: number }>()
    let call = 0
    const wallet = {
      getBalance: () => {
        call += 1
        return call === 1 ? first.promise : second.promise
      },
    }

    // Pre-send read starts and parks inside the provider.
    const preSend = getArkadeBalanceCached(wallet)

    // A send completes and invalidates.
    invalidateArkadeSnapshotCache()

    // A concurrent reader arrives. It must NOT join the pre-send fetch.
    const postSend = getArkadeBalanceCached(wallet)
    expect(call, 'a fresh fetch was started for the post-invalidation reader').toBe(2)

    first.resolve({ total: 10_000 }) // pre-send balance
    second.resolve({ total: 4_000 }) // post-send balance

    expect((await preSend).total).toBe(10_000)
    expect((await postSend).total, 'spent sats must not show as available').toBe(4_000)
  })

  it('the pre-invalidation snapshot is not written back either', async () => {
    const first = deferred<{ total: number }>()
    let call = 0
    const wallet = {
      getBalance: () => {
        call += 1
        return call === 1 ? first.promise : Promise.resolve({ total: 4_000 })
      },
    }

    const preSend = getArkadeBalanceCached(wallet)
    invalidateArkadeSnapshotCache()
    first.resolve({ total: 10_000 })
    await preSend

    // The next reader must not see the pre-send figure from the cache.
    expect((await getArkadeBalanceCached(wallet)).total).toBe(4_000)
  })

  it('a different wallet instance is never served the previous wallet`s snapshot', async () => {
    const a = { getBalance: async () => ({ total: 111 }) }
    const b = { getBalance: async () => ({ total: 222 }) }
    expect((await getArkadeBalanceCached(a)).total).toBe(111)
    expect((await getArkadeBalanceCached(b)).total).toBe(222)
    expect((await getArkadeBalanceCached(a)).total).toBe(111)
  })
})
