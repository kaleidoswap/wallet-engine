/**
 * Spark sent-token-transaction outbox.
 *
 * The Spark SDK exposes no direction for token transactions — a
 * `queryTokenTransactions*` response cannot tell a send apart from a receive
 * (both leave the wallet owning an output: the received amount, or the change
 * of a send). A send with no change output is not returned at all.
 *
 * To make outgoing token transfers visible in history we persist a record of
 * every send the wallet performs. This module is the single source of truth
 * for that outbox; it is intentionally dependency-light so it can be used both
 * by the SparkAdapter and by the low-level `transferTokens` wrapper in
 * `spark-client-manager.ts` without import cycles.
 *
 * Storage is platform-agnostic: it uses the engine's ports storage
 * (`getPlatform()?.storage`, an `IStorageProvider`), persisting the whole
 * record array as a JSON string under a single key. When no platform is set it
 * degrades to an in-module in-memory Map so callers never crash.
 */

import { log } from './log'
import { getPlatform } from '../ports'

/** Single storage key holding the JSON-serialized record array. */
const STORAGE_KEY = 'sparkSentTokenTxHashes'

/** Cap on retained records — newest first, oldest dropped. */
export const MAX_SENT_TOKEN_TX_HISTORY = 200

export interface SentTokenTxRecord {
  hash: string
  /** Spark address of the wallet that created the send. Prevents cross-wallet misclassification. */
  senderSparkAddress?: string
  /** Raw token amount (integer, before decimal division). */
  amount: number
  assetId: string
  ticker: string
  name: string
  decimals: number
  timestamp: number
}

/** In-memory fallback used when no platform storage is injected. */
const memoryStore = new Map<string, string>()

async function readRaw(): Promise<string | null> {
  const storage = getPlatform()?.storage
  if (storage) {
    return storage.get(STORAGE_KEY)
  }
  return memoryStore.get(STORAGE_KEY) ?? null
}

async function writeRaw(value: string): Promise<void> {
  const storage = getPlatform()?.storage
  if (storage) {
    await storage.set(STORAGE_KEY, value)
    return
  }
  memoryStore.set(STORAGE_KEY, value)
}

/** Normalize transaction hashes across SDK/storage shapes. */
export function normalizeTxHash(hash: string): string {
  return hash.trim().toLowerCase().replace(/^0x/, '')
}

export async function loadSentTokenRecords(): Promise<SentTokenTxRecord[]> {
  try {
    const raw = await readRaw()
    if (!raw) return []
    const stored: unknown = JSON.parse(raw)
    if (!Array.isArray(stored)) return []
    return stored
      .map((r): SentTokenTxRecord | null => {
        if (typeof r === 'string') {
          // Legacy format: plain hash string, no amount info — migrate in-place with amount 0.
          return {
            hash: normalizeTxHash(r),
            senderSparkAddress: undefined,
            amount: 0,
            assetId: '',
            ticker: 'TOKEN',
            name: '',
            decimals: 0,
            timestamp: 0,
          }
        }
        if (
          typeof r === 'object' &&
          r !== null &&
          typeof (r as { hash?: unknown }).hash === 'string'
        ) {
          const rec = r as SentTokenTxRecord
          return { ...rec, hash: normalizeTxHash(rec.hash) }
        }
        return null
      })
      .filter((r): r is SentTokenTxRecord => r !== null)
  } catch {
    return []
  }
}

/**
 * Persist a send record. Records are keyed by hash — re-saving the same hash
 * replaces the earlier entry, so a richer record (with token metadata) written
 * after a minimal one supersedes it.
 */
export async function saveSentTokenRecord(record: SentTokenTxRecord): Promise<void> {
  try {
    const normalizedRecord = { ...record, hash: normalizeTxHash(record.hash) }
    if (!normalizedRecord.hash) return
    const existing = await loadSentTokenRecords()
    const updated = [
      normalizedRecord,
      ...existing.filter((r) => normalizeTxHash(r.hash) !== normalizedRecord.hash),
    ].slice(0, MAX_SENT_TOKEN_TX_HISTORY)
    await writeRaw(JSON.stringify(updated))
  } catch (err) {
    log.error('[sent-token-records] Failed to save sent token transaction record:', err)
  }
}
