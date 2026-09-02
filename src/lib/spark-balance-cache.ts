/** Short-lived, same-wallet cache for coalescing Spark balance reads. */

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
// Readers must not share a fetch from before the latest invalidation.
let inflightGeneration = 0
// This module-level cache is shared by both Spark adapters, so bind it by identity.
let cachedWallet: SparkWalletInstance | null = null
// Generations prevent pre-mutation snapshots from being written back.
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
  // Share only current-generation reads; older ones predate a balance mutation.
  if (inflightBalance && inflightGeneration === cacheGeneration) return inflightBalance

  const startedGeneration = cacheGeneration
  inflightGeneration = startedGeneration
  inflightBalance = (async () => {
    try {
      const value = await withTimeout(wallet.getBalance(), SPARK_RPC_TIMEOUT_MS, 'spark.getBalance')
      // Do not cache a snapshot captured before an intervening mutation.
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
