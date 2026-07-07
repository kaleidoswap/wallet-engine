/**
 * In-adapter cache for `wallet.getBalance()`.
 *
 * The dashboard render issues `getNodeInfo`, `getBtcBalance` and
 * `listAssets` back-to-back, and all three want the same balance snapshot.
 * Without this cache, three sequential Spark hangs is the worst-case
 * load latency when the gateway is slow. With it, concurrent callers within
 * a 3 s window share a single RPC.
 *
 * Errors are NOT cached — the next caller after a failure retries fresh.
 * Empty snapshots (Spark still syncing on cold start) get a much shorter
 * TTL than populated ones, so the UI doesn't get stuck on "0 sats" while
 * the wallet syncs.
 */

import { sparkClientManager } from './spark-client-manager'
import { isEmptyBalance, withTimeout } from './spark-helpers'

/**
 * Default timeout (ms) for Spark RPC calls that hit the Flashnet/Spark
 * gateway. The Spark SDK's own timeout is 30 s; that's too long when the
 * upstream returns HTTP 520/524 — it freezes the wallet UI. Fail fast so
 * callers can recover.
 */
export const SPARK_RPC_TIMEOUT_MS = 8_000

/**
 * Short coalescing window for `wallet.getBalance()`. Collapses the burst of
 * simultaneous reads from a single dashboard render into one RPC.
 */
export const SPARK_BALANCE_CACHE_TTL_MS = 3_000

/**
 * Cold-start TTL for an empty balance snapshot. The Spark SDK reports
 * `{ balance: 0n, tokenBalances: empty }` while it's still syncing the
 * wallet — caching that for the full 3 s window strands the UI on
 * "0 sats" even after the sync completes. Using a tighter TTL for empty
 * results lets the next dashboard render re-query quickly.
 */
export const SPARK_EMPTY_BALANCE_TTL_MS = 500

export type SparkWalletInstance = ReturnType<typeof sparkClientManager.getWallet>
export type SparkBalanceSnapshot = Awaited<ReturnType<SparkWalletInstance['getBalance']>>

let cachedBalance: { value: SparkBalanceSnapshot; fetchedAt: number } | null = null
let inflightBalance: Promise<SparkBalanceSnapshot> | null = null
// The wallet instance the cached value / in-flight fetch belongs to. The engine
// holds a single active Spark wallet at a time, but this cache is a module-level
// singleton shared by both Spark adapters — so if the active wallet is ever
// swapped (account switch), serving the previous wallet's balance for the new
// one would mislabel one account's funds as another's. A changed identity is
// treated as a hard cache miss.
let cachedWallet: SparkWalletInstance | null = null
// Bumped on every invalidation. An in-flight fetch captures the generation at
// its start; if that changes before it settles (i.e. a send/receive invalidated
// the cache mid-flight), the fetched snapshot predates the mutation and must NOT
// be written back — otherwise the pre-send (higher) balance would be served for
// the rest of the TTL window, showing spent sats as still available.
let cacheGeneration = 0

/**
 * Fetch `wallet.getBalance()` with same-tick dedupe + a small TTL cache.
 * Concurrent callers within the active TTL share the same RPC, so a single
 * dashboard render only ever hits the gateway once.
 *
 * Empty-balance snapshots (Spark still syncing) get a much shorter TTL
 * than populated ones — see SPARK_EMPTY_BALANCE_TTL_MS.
 *
 * Errors are NOT cached — the next caller after a failure retries fresh.
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
  if (inflightBalance) return inflightBalance

  const startedGeneration = cacheGeneration
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
      inflightBalance = null
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
 * Test-only: drop both the cached value and any in-flight request.
 * Production code should use `invalidateSparkBalanceCache()` — it leaves
 * an in-flight request running so its eventual settlement re-populates the
 * cache instead of double-fetching.
 */
export function _resetSparkBalanceCacheForTests(): void {
  cachedBalance = null
  inflightBalance = null
  cachedWallet = null
  cacheGeneration++
}
