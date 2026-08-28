/**
 * Spark sent-token-transaction outbox.
 *
 * The Spark SDK exposes no direction for token transactions: a
 * `queryTokenTransactions*` response cannot tell a send from a receive (both leave
 * the wallet owning an output), and a send with no change output is not returned at
 * all. So every send the wallet performs is recorded here to make outgoing
 * transfers visible in history.
 *
 * Intentionally dependency-light so both the SparkAdapter and the low-level
 * `transferTokens` wrapper can use it without import cycles. Storage goes through
 * the engine's ports (`IStorageProvider`), persisting the record array as JSON under
 * one key, degrading to an in-memory Map when no platform is set.
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
 * Persist a send record. Records are keyed by hash, so re-saving the same hash
 * replaces the earlier entry and a richer record supersedes a minimal one.
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
