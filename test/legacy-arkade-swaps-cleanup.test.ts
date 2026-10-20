import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupLegacyArkadeSwapsDb,
  isFinalLegacySwap,
  LEGACY_ARKADE_SWAPS_DB,
  resetLegacyArkadeSwapsCleanup,
} from '../src/lib/legacy-arkade-swaps-cleanup'

type Record_ = { id: string; type: string; status: string; refunded?: boolean }

/** Just enough of IDBFactory for the cleanup: open (no create), getAll, delete. */
function fakeIdb(initial?: { stores: Record<string, Record_[]> }) {
  let db = initial ? { stores: initial.stores } : null
  const deleted: string[] = []
  const later = (fn: () => void) => queueMicrotask(fn)
  const factory = {
    open(name: string) {
      const req: any = {}
      later(() => {
        if (name !== LEGACY_ARKADE_SWAPS_DB || !db) {
          let aborted = false
          req.transaction = { abort: () => (aborted = true) }
          req.onupgradeneeded?.({ oldVersion: 0 })
          if (aborted) {
            req.error = new DOMException('aborted', 'AbortError')
            return req.onerror?.()
          }
        }
        const stores = db!.stores
        req.result = {
          objectStoreNames: { contains: (n: string) => n in stores },
          transaction: (n: string) => ({
            objectStore: () => ({
              getAll: () => {
                const r: any = {}
                later(() => {
                  r.result = stores[n]
                  r.onsuccess?.()
                })
                return r
              },
            }),
          }),
          close: () => {},
        }
        req.onsuccess?.()
      })
      return req
    },
    deleteDatabase(name: string) {
      const req: any = {}
      later(() => {
        deleted.push(name)
        db = null
        req.onsuccess?.()
      })
      return req
    },
  }
  return { factory: factory as unknown as IDBFactory, deleted, exists: () => db !== null }
}

afterEach(() => resetLegacyArkadeSwapsCleanup())

describe('cleanupLegacyArkadeSwapsDb', () => {
  it('reports unavailable without indexedDB', async () => {
    await expect(cleanupLegacyArkadeSwapsDb(undefined)).resolves.toEqual({ status: 'unavailable' })
  })

  it('does not create the database when it is absent', async () => {
    const idb = fakeIdb()
    await expect(cleanupLegacyArkadeSwapsDb(idb.factory)).resolves.toEqual({ status: 'absent' })
    expect(idb.exists()).toBe(false)
    expect(idb.deleted).toEqual([])
  })

  it('deletes a database holding only final swaps', async () => {
    const idb = fakeIdb({
      stores: {
        swaps: [
          { id: 'r1', type: 'reverse', status: 'invoice.settled' },
          { id: 's1', type: 'submarine', status: 'transaction.claimed' },
          { id: 's2', type: 'submarine', status: 'invoice.failedToPay', refunded: true },
        ],
      },
    })
    await expect(cleanupLegacyArkadeSwapsDb(idb.factory)).resolves.toEqual({ status: 'deleted' })
    expect(idb.deleted).toEqual([LEGACY_ARKADE_SWAPS_DB])
  })

  it('deletes an empty database', async () => {
    const idb = fakeIdb({ stores: {} })
    await expect(cleanupLegacyArkadeSwapsDb(idb.factory)).resolves.toEqual({ status: 'deleted' })
  })

  it('keeps the database when a swap may still hold funds', async () => {
    const idb = fakeIdb({
      stores: {
        swaps: [
          { id: 'r1', type: 'reverse', status: 'invoice.settled' },
          { id: 's1', type: 'submarine', status: 'transaction.mempool' },
        ],
      },
    })
    await expect(cleanupLegacyArkadeSwapsDb(idb.factory)).resolves.toEqual({
      status: 'kept',
      unfinished: ['s1'],
    })
    expect(idb.deleted).toEqual([])
  })

  it('runs once per process', async () => {
    const first = fakeIdb({ stores: { swaps: [] } })
    const second = fakeIdb({ stores: { swaps: [] } })
    await cleanupLegacyArkadeSwapsDb(first.factory)
    await cleanupLegacyArkadeSwapsDb(second.factory)
    expect(second.deleted).toEqual([])
  })
})

describe('isFinalLegacySwap', () => {
  it('treats an unrefunded expired or failed submarine swap as unfinished', () => {
    expect(isFinalLegacySwap({ type: 'submarine', status: 'swap.expired' })).toBe(false)
    expect(isFinalLegacySwap({ type: 'submarine', status: 'invoice.failedToPay' })).toBe(false)
    expect(isFinalLegacySwap({ type: 'reverse', status: 'transaction.confirmed' })).toBe(false)
    expect(isFinalLegacySwap({ type: 'chain', status: 'transaction.claimed' })).toBe(true)
    expect(isFinalLegacySwap({ status: 'invoice.settled' })).toBe(false)
  })
})
