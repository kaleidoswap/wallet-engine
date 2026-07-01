import { describe, it, expect, beforeEach } from 'vitest'
import { setPlatform, type IStorageProvider } from '../src/ports'
import {
  loadSentTokenRecords,
  saveSentTokenRecord,
  normalizeTxHash,
  MAX_SENT_TOKEN_TX_HISTORY,
  type SentTokenTxRecord,
} from '../src/lib/spark-sent-token-records'

/** Fresh in-memory IStorageProvider so each test starts from an empty store. */
function memStorage(): IStorageProvider {
  const m = new Map<string, string>()
  return {
    async get(k) {
      return m.get(k) ?? null
    },
    async set(k, v) {
      m.set(k, v)
    },
    async remove(k) {
      m.delete(k)
    },
    async keys() {
      return [...m.keys()]
    },
  }
}

function rec(hash: string, amount: number): SentTokenTxRecord {
  return { hash, amount, assetId: 'a', ticker: 'TKN', name: 'Token', decimals: 0, timestamp: amount }
}

beforeEach(() => {
  setPlatform({
    storage: memStorage(),
    runtime: { host: 'node', randomBytes: (n) => new Uint8Array(n), now: () => 0 },
  })
})

describe('normalizeTxHash', () => {
  it('lowercases, trims, and strips a 0x prefix', () => {
    expect(normalizeTxHash('  0xABCdef  ')).toBe('abcdef')
    expect(normalizeTxHash('DEADBEEF')).toBe('deadbeef')
  })
})

describe('sent-token-records round-trip via injected storage', () => {
  it('returns [] when nothing is stored', async () => {
    expect(await loadSentTokenRecords()).toEqual([])
  })

  it('persists and reloads a record (hash normalized)', async () => {
    await saveSentTokenRecord(rec('0xFIRST', 1))
    const loaded = await loadSentTokenRecords()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].hash).toBe('first')
    expect(loaded.find((r) => r.hash === 'first')?.amount).toBe(1)
  })

  it('newest-first ordering and supersede-by-hash (no duplicates)', async () => {
    await saveSentTokenRecord(rec('a', 1))
    await saveSentTokenRecord(rec('b', 2))
    await saveSentTokenRecord(rec('0xA', 3)) // same hash as 'a', richer/newer
    const loaded = await loadSentTokenRecords()
    expect(loaded.map((r) => r.hash)).toEqual(['a', 'b'])
    expect(loaded.find((r) => r.hash === 'a')?.amount).toBe(3) // superseded
  })

  it('caps retained records at MAX_SENT_TOKEN_TX_HISTORY (newest kept)', async () => {
    for (let i = 0; i < MAX_SENT_TOKEN_TX_HISTORY + 25; i++) {
      await saveSentTokenRecord(rec(`h${i}`, i))
    }
    const loaded = await loadSentTokenRecords()
    expect(loaded).toHaveLength(MAX_SENT_TOKEN_TX_HISTORY)
    expect(loaded[0].hash).toBe(`h${MAX_SENT_TOKEN_TX_HISTORY + 24}`) // newest first
  })

  it('migrates legacy plain-string entries to records with amount 0', async () => {
    // Seed the store directly with the legacy format (array of hash strings).
    const storage = memStorage()
    await storage.set('sparkSentTokenTxHashes', JSON.stringify(['0xLEGACY', 'other']))
    setPlatform({
      storage,
      runtime: { host: 'node', randomBytes: (n) => new Uint8Array(n), now: () => 0 },
    })
    const loaded = await loadSentTokenRecords()
    expect(loaded.map((r) => r.hash)).toEqual(['legacy', 'other'])
    expect(loaded.every((r) => r.amount === 0)).toBe(true)
  })
})
