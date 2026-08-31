/**
 * In-adapter cache for `wallet.getBalance()`.
 *
 * A dashboard render issues `getNodeInfo`, `getBtcBalance` and `listAssets`
 * back-to-back, all wanting the same snapshot, so concurrent callers within a 3s
 * window share one RPC instead of three sequential Spark hangs.
 *
 * Errors are NOT cached. Empty snapshots (Spark still syncing on cold start) get a
 * much shorter TTL, so the UI doesn't stick on "0 sats" mid-sync.
 */

import { sparkClientManager } from './spark-client-manager'
import { isEmptyBalance, withTimeout } from './spark-helpers'

/**
 * Default timeout (ms) for Spark RPCs. The SDK's own is 30s, too long when the
 * upstream returns HTTP 520/524 — it freezes the wallet UI.
 */
export const SPARK_RPC_TIMEOUT_MS = 8_000

/**
 * Coalescing window for `wallet.getBalance()`, collapsing one dashboard render's
 * burst of reads into a single RPC.
 */
export const SPARK_BALANCE_CACHE_TTL_MS = 3_000

/**
 * Cold-start TTL for an empty snapshot. The SDK reports `{ balance: 0n }` while
 * still syncing; caching that for the full window strands the UI on "0 sats".
 */
export const SPARK_EMPTY_BALANCE_TTL_MS = 500

export type SparkWalletInstance = ReturnType<typeof sparkClientManager.getWallet>
export type SparkBalanceSnapshot = Awaited<ReturnType<SparkWalletInstance['getBalance']>>

let cachedBalance: { value: SparkBalanceSnapshot; fetchedAt: number } | null = null
let inflightBalance: Promise<SparkBalanceSnapshot> | null = null
// The generation the in-flight fetch started in. A fetch begun before an
// invalidation is stale for READERS too, not just for the cache write-back —
// serving it hands a post-send caller the pre-send balance (finding O6).
let inflightGeneration = 0
// The wallet instance the cached value / in-flight fetch belongs to. This cache is
// a module-level singleton shared by both Spark adapters, so on an account switch
// serving the previous wallet's balance would mislabel one account's funds as
// another's. A changed identity is a hard cache miss.
let cachedWallet: SparkWalletInstance | null = null
// Bumped on every invalidation. An in-flight fetch captures the generation at
// start; if it changed before settling, the snapshot predates the mutation and
// must NOT be written back — otherwise the pre-send balance is served for the rest
// of the window, showing spent sats as available.
let cacheGeneration = 0

/**
 * Fetch `wallet.getBalance()` with same-tick dedupe and a small TTL cache, so one
 * dashboard render hits the gateway once. Empty snapshots get a shorter TTL (see
 * SPARK_EMPTY_BALANCE_TTL_MS); errors are not cached.
 */
export async function getSparkBalanceCached(
  wallet: SparkWalletInstance,
): Promise<SparkBalanceSnapshot> {
  // A different wallet instance must never be served the prior wallet's balance.
  if (wallet !== cachedWallet) {
    cachedWallet = wallet
    cachedBalance = null
    inflightBalance = null
    cacheGeneration++
  }

  const now = Date.now()
  if (cachedBalance) {
    const ttl = isEmptyBalance(cachedBalance.value)
      ? SPARK_EMPTY_BALANCE_TTL_MS
      : SPARK_BALANCE_CACHE_TTL_MS
    if (now - cachedBalance.fetchedAt < ttl) {
      return cachedBalance.value
    }
  }
  // Share the in-flight fetch only when it started in the current generation.
  // Otherwise it predates an invalidation (a completed send/receive) and would
  // report spent sats as still available — the same staleness the write-back
  // guard below rejects. Let it finish for whoever already holds it; start a
  // fresh fetch for this caller.
  if (inflightBalance && inflightGeneration === cacheGeneration) return inflightBalance

  const startedGeneration = cacheGeneration
  inflightGeneration = startedGeneration
  inflightBalance = (async () => {
    try {
      const value = await withTimeout(wallet.getBalance(), SPARK_RPC_TIMEOUT_MS, 'spark.getBalance')
      // Only populate the cache if no invalidation happened while this fetch was
      // in flight; a snapshot captured before an intervening send/receive is
      // already stale and must not become the served value.
      if (cacheGeneration === startedGeneration) {
        cachedBalance = { value, fetchedAt: Date.now() }
      }
      return value
    } finally {
      // Only clear the slot if this fetch still owns it; a superseded fetch
      // settling later must not wipe a newer one's dedupe.
      if (inflightGeneration === startedGeneration) inflightBalance = null
    }
  })()

  return inflightBalance
}

/** Drop the in-adapter balance cache (call after a send/receive completes). */
export function invalidateSparkBalanceCache(): void {
  cachedBalance = null
  // Invalidate any in-flight fetch's result too (it may predate this mutation),
  // while still letting it run so concurrent callers don't trigger a re-fetch.
  cacheGeneration++
}

/**
 * Test-only: drop the cached value and any in-flight request. Production code uses
 * `invalidateSparkBalanceCache()`, which leaves an in-flight request running so
 * its settlement re-populates the cache instead of double-fetching.
 */
export function _resetSparkBalanceCacheForTests(): void {
  cachedBalance = null
  inflightBalance = null
  inflightGeneration = 0
  cachedWallet = null
  cacheGeneration++
}
