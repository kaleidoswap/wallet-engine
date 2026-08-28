/**
 * Short-lived snapshot cache for Arkade `getBalance()` and `getVtxos()` — the
 * Arkade sibling of spark-balance-cache. Concurrent callers within the TTL share a
 * single RPC, so one dashboard render doesn't repeat the same reads.
 *
 * Deliberately NOT used for send-path coin selection: picking VTXOs from a snapshot
 * up to TTL old could double-select a just-spent VTXO, so mutating operations must
 * call {@link invalidateArkadeSnapshotCache}.
 *
 * Errors are not cached. Empty snapshots (still syncing) use a much shorter TTL so
 * the UI doesn't sit on "0 sats".
 */

import { log } from './log'

export const ARKADE_SNAPSHOT_TTL_MS = 3_000
export const ARKADE_EMPTY_SNAPSHOT_TTL_MS = 500

interface ArkadeBalanceSource {
  getBalance(): Promise<unknown>
}
interface ArkadeVtxoSource {
  getVtxos(): Promise<unknown>
}

interface CacheEntry {
  value: unknown
  fetchedAt: number
}

let cachedWallet: unknown = null
// Bumped on every invalidation. In-flight fetches capture the generation at
// start; a mismatch when they settle means a mutation happened mid-flight and
// the (pre-mutation) result must not be written back.
let generation = 0

let balanceEntry: CacheEntry | null = null
let inflightBalance: Promise<unknown> | null = null
let vtxosEntry: CacheEntry | null = null
let inflightVtxos: Promise<unknown> | null = null

function ensureWallet(wallet: unknown): void {
  if (wallet !== cachedWallet) {
    // A different wallet instance must never see the prior wallet's snapshot.
    cachedWallet = wallet
    invalidateArkadeSnapshotCache()
  }
}

function isEmptyBalance(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true
  const v = value as { total?: unknown; settled?: unknown; boarding?: { total?: unknown } }
  return !Number(v.total ?? 0) && !Number(v.settled ?? 0) && !Number(v.boarding?.total ?? 0)
}

function isEmptyVtxos(value: unknown): boolean {
  return !Array.isArray(value) || value.length === 0
}

function fresh(entry: CacheEntry | null, isEmpty: (value: unknown) => boolean): boolean {
  if (!entry) return false
  const ttl = isEmpty(entry.value) ? ARKADE_EMPTY_SNAPSHOT_TTL_MS : ARKADE_SNAPSHOT_TTL_MS
  return Date.now() - entry.fetchedAt < ttl
}

async function readThrough<T>(params: {
  wallet: unknown
  entry: () => CacheEntry | null
  setEntry: (entry: CacheEntry | null) => void
  inflight: () => Promise<unknown> | null
  setInflight: (promise: Promise<unknown> | null) => void
  isEmpty: (value: unknown) => boolean
  fetch: () => Promise<T>
  label: string
}): Promise<T> {
  ensureWallet(params.wallet)

  const entry = params.entry()
  if (fresh(entry, params.isEmpty)) return entry!.value as T

  const inflight = params.inflight()
  if (inflight) return inflight as Promise<T>

  const startGeneration = generation
  const promise = params
    .fetch()
    .then((value) => {
      if (generation === startGeneration) {
        params.setEntry({ value, fetchedAt: Date.now() })
      } else {
        log.debug(`[arkade-snapshot] ${params.label} invalidated mid-flight; not cached`)
      }
      return value
    })
    .finally(() => {
      if (params.inflight() === promise) params.setInflight(null)
    })
  params.setInflight(promise)
  return promise
}

/** `wallet.getBalance()` through the shared snapshot (single-flight, 3s TTL). */
export function getArkadeBalanceCached<TWallet extends ArkadeBalanceSource>(
  wallet: TWallet,
): Promise<Awaited<ReturnType<TWallet['getBalance']>>> {
  return readThrough({
    wallet,
    entry: () => balanceEntry,
    setEntry: (entry) => (balanceEntry = entry),
    inflight: () => inflightBalance,
    setInflight: (promise) => (inflightBalance = promise),
    isEmpty: isEmptyBalance,
    fetch: () => wallet.getBalance(),
    label: 'balance',
  }) as Promise<Awaited<ReturnType<TWallet['getBalance']>>>
}

/** `wallet.getVtxos()` through the shared snapshot (single-flight, 3s TTL). */
export function getArkadeVtxosCached<TWallet extends ArkadeVtxoSource>(
  wallet: TWallet,
): Promise<Awaited<ReturnType<TWallet['getVtxos']>>> {
  return readThrough({
    wallet,
    entry: () => vtxosEntry,
    setEntry: (entry) => (vtxosEntry = entry),
    inflight: () => inflightVtxos,
    setInflight: (promise) => (inflightVtxos = promise),
    isEmpty: isEmptyVtxos,
    fetch: () => wallet.getVtxos(),
    label: 'vtxos',
  }) as Promise<Awaited<ReturnType<TWallet['getVtxos']>>>
}

/** Drop the snapshot — call after any mutation (send, onboard, offboard). */
export function invalidateArkadeSnapshotCache(): void {
  balanceEntry = null
  vtxosEntry = null
  inflightBalance = null
  inflightVtxos = null
  generation++
}

/** Test hook. */
export function _resetArkadeSnapshotCacheForTests(): void {
  cachedWallet = null
  invalidateArkadeSnapshotCache()
}
