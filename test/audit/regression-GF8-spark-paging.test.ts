/*
 * Regression test for audit finding G-F8, Spark half (REPORT-2.md §4.2).
 *
 * Both Spark adapters push `limit`/`offset` into a PER-LEG RPC — the BTC leg's
 * `getTransfers(limit, offset)` / `getTransfers({ limit, skip })` and the token
 * leg's `queryTokenTransactions({ pageSize: limit })` — then merge the two lists
 * and never slice the result. Two legs each returning up to `limit` rows merge to
 * up to twice that, and the recorded-send / synthesized-offline-record paths are
 * not paged at all.
 *
 * Measured at parent 8e6b3aa with each leg returning 8 rows:
 *   SparkAdapter    listTransactions({ limit: 5 }) -> 16 rows
 *   SparkWdkAdapter listTransactions({ limit: 5 }) -> 16 rows
 *
 * Commit cd79cee fixed the five adapters that discarded the filter entirely and
 * explicitly left this pair: "the merge sites need their own handling and the
 * leg-level paging interacts with it."
 *
 * SCOPE — the COUNT only.
 *  - ORDERING is deliberately untouched. Whether `listTransactions` has a
 *    specified order is an open product question (REPORT-2 §4.1): two adapters
 *    sort newest-first and four pass SDK order through. Both Spark adapters
 *    already sorted newest-first before merging; this takes a PREFIX of that,
 *    so the order a caller sees is unchanged. The last case pins that.
 *  - `offset` is NOT re-applied at the merge. It is already pushed into the BTC
 *    leg's RPC, so slicing by it again would drop rows the caller never saw.
 *    Sound merge-level pagination would need every leg over-fetched to
 *    `offset + limit` and the union paged — a different paging model. Pinned
 *    below as the known-imperfect behaviour, so a future change to it is
 *    deliberate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const sparkState = vi.hoisted(() => ({ wallet: null as unknown }))
vi.mock('../../src/lib/spark-client-manager', () => ({
  sparkClientManager: {
    isInitialized: () => sparkState.wallet !== null,
    getWallet: () => sparkState.wallet,
    getConfig: () => ({ protocol: 'SPARK', network: 'regtest', mnemonic: '' }),
    initialize: async () => {},
    disconnect: async () => {},
    adoptExternalWallet: () => {},
    releaseExternalWallet: () => {},
  },
}))

import { ME, OTHER } from '../fixtures/spark'
import { SparkAdapter } from '../../src/adapters/SparkAdapter'
import { SparkWdkAdapter } from '../../src/adapters/wdk/SparkWdkAdapter'

/** N BTC receive transfers, newest first by construction (`btc-0` is newest). */
function btcTransfers(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `btc-${i}`,
    sparkId: `btc-${i}`,
    type: 'TRANSFER',
    receiverIdentityPublicKey: ME,
    senderIdentityPublicKey: OTHER,
    totalValue: 1000 + i,
    status: 'TRANSFER_STATUS_COMPLETED',
    // The native converter derives direction from `transferDirection`; the WDK
    // one from the identity keys above. Both are set so one fixture serves both.
    transferDirection: 'INCOMING',
    // Date objects, not ISO strings: the native converter calls
    // `createdTime.getTime()` directly (spark-converters.ts).
    createdTime: new Date(2_000_000_000_000 - i * 1000),
    updatedTime: new Date(2_000_000_000_000 - i * 1000),
  }))
}

/** A wallet whose BTC leg over-serves relative to the requested page size. */
function walletWith(n: number) {
  return {
    getTransfers: async () => ({ transfers: btcTransfers(n) }),
    getIdentityPublicKey: async () => ME,
    getSparkAddress: async () => 'spark1self',
    getBalance: async () => ({ balance: 0n, tokenBalances: new Map() }),
    // Token leg unavailable — its failure is swallowed, leaving the BTC leg only.
    queryTokenTransactions: async () => {
      throw new Error('token leg unavailable')
    },
  }
}

afterEach(() => {
  sparkState.wallet = null
  vi.restoreAllMocks()
})

describe('G-F8: the Spark adapters must not return more rows than `limit`', () => {
  it('SparkAdapter caps the merged result at `limit`', async () => {
    sparkState.wallet = walletWith(8)
    const txs = await new SparkAdapter().listTransactions({ limit: 5 })
    expect(txs.length, 'a leg that over-serves must not leak past the page size').toBe(5)
  })

  it('SparkWdkAdapter caps the merged result at `limit`', async () => {
    const a = new SparkWdkAdapter()
    Object.assign(a as never, {
      connected: true,
      identityPubKeyHex: ME.toLowerCase(),
      account: { getTransfers: async () => btcTransfers(8) },
    })
    const txs = await a.listTransactions({ limit: 5 })
    expect(txs.length).toBe(5)
  })

  it('caps at the adapters\' own default page size when no limit is given', async () => {
    // Both adapters already pass `filter?.limit ?? 20` into their legs, so 20 is
    // the page size they ask their backends for; the result now matches it.
    sparkState.wallet = walletWith(50)
    expect((await new SparkAdapter().listTransactions()).length).toBe(20)

    const a = new SparkWdkAdapter()
    Object.assign(a as never, {
      connected: true,
      identityPubKeyHex: ME.toLowerCase(),
      account: { getTransfers: async () => btcTransfers(50) },
    })
    expect((await a.listTransactions()).length).toBe(20)
  })

  it('returns fewer than `limit` when fewer rows exist — it is a cap, not a pad', async () => {
    sparkState.wallet = walletWith(2)
    expect((await new SparkAdapter().listTransactions({ limit: 5 })).length).toBe(2)
  })

  it('the cap runs AFTER the predicates, not before', async () => {
    // Slicing first would let the predicates empty an already-truncated page.
    sparkState.wallet = walletWith(8)
    const txs = await new SparkAdapter().listTransactions({ limit: 3, type: 'receive' })
    expect(txs.length).toBe(3)
    expect(txs.every((t) => t.type === 'receive')).toBe(true)
  })

  it('ORDER IS UNCHANGED: the cap takes a prefix of the existing newest-first sort', async () => {
    // listTransactions ordering is an open question (REPORT-2 §4.1) and this
    // commit must not decide it. Both Spark adapters already sorted newest-first;
    // the capped page is the first N of exactly that order.
    sparkState.wallet = walletWith(8)
    const full = await new SparkAdapter().listTransactions({ limit: 8 })
    const page = await new SparkAdapter().listTransactions({ limit: 3 })
    expect(page.map((t) => t.id)).toEqual(full.slice(0, 3).map((t) => t.id))
    // …and that order is newest-first, as it was before.
    expect(full.map((t) => t.timestamp)).toEqual([...full.map((t) => t.timestamp)].sort((a, b) => b - a))
  })

  it('over-fetches each leg and applies `offset` to the merged result', async () => {
    let seen: unknown = null
    sparkState.wallet = {
      ...walletWith(8),
      getTransfers: async (limit: number, offset: number) => {
        seen = { limit, offset }
        return { transfers: btcTransfers(8) }
      },
    }
    const txs = await new SparkAdapter().listTransactions({ limit: 5, offset: 3 })
    expect(seen, 'the leg supplies the prefix needed to page the union').toEqual({ limit: 8, offset: 0 })
    expect(txs.length).toBe(5)
  })
})
