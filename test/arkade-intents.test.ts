import { describe, it, expect, beforeEach } from 'vitest'
import { registerWdkModule } from '../src/adapters/wdk/moduleLoader'
import { arkadeIntentsClientManager } from '../src/lib/arkade-intents-client-manager'
import { ArkadeIntentsStore } from '../src/swap/arkade-intents-store'
import { getPlatform, setPlatform } from '../src/ports'
import type { IStorageProvider } from '../src/ports'

/**
 * Arkade Intents wiring: the store's persistence contract (the venue writes records
 * BEFORE funding, so a lossy store is stranded funds) and the manager's
 * generation-counted lifecycle (a dispose() during a slow init must discard the
 * stale venue). The venue module itself is faked through the module-loader registry.
 */

class MemoryStorage implements IStorageProvider {
  private map = new Map<string, string>()
  async get(key: string) {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string) {
    this.map.set(key, value)
  }
  async remove(key: string) {
    this.map.delete(key)
  }
  async keys() {
    return [...this.map.keys()]
  }
}

const record = (id: string, phase: string) => ({
  id,
  phase,
  route: 'arkade:BTC->lightning:BTC',
  createdAt: 1_800_000_000,
  quote: { rfq_id: id, from_amount: 1_050, to_amount: 1_000 },
  scriptOptions: { refundLocktime: '1800003600' },
})

describe('ArkadeIntentsStore', () => {
  let storage: MemoryStorage
  let store: ArkadeIntentsStore

  beforeEach(() => {
    storage = new MemoryStorage()
    store = new ArkadeIntentsStore(storage)
  })

  it('round-trips a record exactly', async () => {
    const original = record('rfq-1', 'prepared')
    await store.put(original)
    expect(await store.get('rfq-1')).toEqual(original)
  })

  it('lists only prepared/funded records as pending', async () => {
    await store.put(record('rfq-a', 'prepared'))
    await store.put(record('rfq-b', 'funded'))
    await store.put(record('rfq-c', 'settled'))
    await store.put(record('rfq-d', 'refunded'))
    // A neighbouring namespace must not leak into the listing.
    await storage.set('boltz:chain:swap:x', JSON.stringify({ id: 'x', phase: 'prepared' }))
    const pending = await store.listPending()
    expect(pending.map((r) => r.id).sort()).toEqual(['rfq-a', 'rfq-b'])
  })

  it('updates in place under the same key', async () => {
    await store.put(record('rfq-1', 'prepared'))
    await store.put({ ...record('rfq-1', 'funded'), fundingTxid: 'tx' })
    const stored = await store.get('rfq-1')
    expect(stored?.phase).toBe('funded')
    expect(stored?.fundingTxid).toBe('tx')
    expect((await store.listPending()).length).toBe(1)
  })

  it('fromPlatform uses the injected platform storage', async () => {
    const previous = getPlatform()
    setPlatform({ storage } as never)
    try {
      const platformStore = ArkadeIntentsStore.fromPlatform()
      await platformStore.put(record('rfq-p', 'prepared'))
      expect((await store.get('rfq-p'))?.id).toBe('rfq-p')
    } finally {
      if (previous) setPlatform(previous)
    }
  })
})

describe('arkadeIntentsClientManager', () => {
  const wallet = {} as never

  /** A controllable fake venue module, registered under the subpath key. */
  const installFakeModule = (options?: { delayMs?: number }) => {
    const constructed: unknown[] = []
    class FakeVenue {
      options: unknown
      constructor(venueOptions: unknown) {
        this.options = venueOptions
        constructed.push(this)
      }
      async reconcile() {
        return {
          settled: [],
          refunded: [],
          cancelled: [],
          needsRecovery: [],
          pending: [],
          errors: [],
        }
      }
    }
    registerWdkModule('@kaleidorg/swap-sdk/arkade', async () => {
      if (options?.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      }
      return { ArkadeIntentsVenue: FakeVenue }
    })
    return { constructed }
  }

  beforeEach(async () => {
    await arkadeIntentsClientManager.dispose()
  })

  it('initializes through the module loader and exposes the venue', async () => {
    installFakeModule()
    await arkadeIntentsClientManager.initialize(wallet, {
      arkServerUrl: 'https://ark.example',
      transport: {},
      store: new ArkadeIntentsStore(new MemoryStorage()),
    })
    expect(arkadeIntentsClientManager.isInitialized()).toBe(true)
    const report = await arkadeIntentsClientManager.getVenue().reconcile()
    expect(report.errors).toEqual([])
  })

  it('throws before initialization', () => {
    expect(() => arkadeIntentsClientManager.getVenue()).toThrow(/not initialized/)
  })

  it('a dispose during a slow init discards the stale venue', async () => {
    installFakeModule({ delayMs: 30 })
    const init = arkadeIntentsClientManager.initialize(wallet, {
      arkServerUrl: 'https://ark.example',
      transport: {},
      store: new ArkadeIntentsStore(new MemoryStorage()),
    })
    await arkadeIntentsClientManager.dispose()
    await init
    expect(arkadeIntentsClientManager.isInitialized()).toBe(false)
  })

  it('dispose closes the host transport best-effort', async () => {
    installFakeModule()
    let closed = 0
    await arkadeIntentsClientManager.initialize(wallet, {
      arkServerUrl: 'https://ark.example',
      transport: {
        close: () => {
          closed += 1
        },
      },
      store: new ArkadeIntentsStore(new MemoryStorage()),
    })
    await arkadeIntentsClientManager.dispose()
    expect(closed).toBe(1)
    expect(arkadeIntentsClientManager.isInitialized()).toBe(false)
  })
})
