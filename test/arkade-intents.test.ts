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

describe('ArkadeIntentsStore scoping', () => {
  const walletOf = (byte: number) => ({ identity: { xOnlyPublicKey: async () => new Uint8Array(32).fill(byte) } })
  const scopeA = { network: 'mutinynet', walletId: 'aa'.repeat(32) }

  it('keeps wallets and networks apart', async () => {
    const storage = new MemoryStorage()
    const a = new ArkadeIntentsStore(storage, scopeA)
    const b = new ArkadeIntentsStore(storage, { ...scopeA, walletId: 'bb'.repeat(32) })
    const aMainnet = new ArkadeIntentsStore(storage, { ...scopeA, network: 'bitcoin' })
    await a.put(record('rfq-1', 'prepared'))
    await a.linkPaymentHash('AB12', 'rfq-1')
    await a.setFundingMarker('rfq-1', { startedAt: 1, fundingTxid: 'tx' })
    for (const other of [b, aMainnet, new ArkadeIntentsStore(storage)]) {
      expect(await other.get('rfq-1')).toBeUndefined()
      expect(await other.list()).toEqual([])
      expect(await other.idForPaymentHash('ab12')).toBeUndefined()
      expect(await other.getFundingMarker('rfq-1')).toBeUndefined()
    }
    expect(await a.idForPaymentHash('ab12')).toBe('rfq-1')
    expect([...(await a.listFundingMarkers()).keys()]).toEqual(['rfq-1'])
  })

  it('refuses an empty scope', () => {
    expect(() => new ArkadeIntentsStore(new MemoryStorage(), { network: '', walletId: 'aa' })).toThrow()
    expect(() => new ArkadeIntentsStore(new MemoryStorage(), { network: 'mutinynet', walletId: '' })).toThrow()
  })

  const owned = (id: string, owner: 'sender' | 'receiver', key: string) => ({
    ...record(id, 'funded'),
    ...(owner === 'receiver' ? { route: 'lightning:BTC->arkade:BTC' } : {}),
    scriptOptions: { refundLocktime: '1800003600', [`${owner}Hex`]: key, [`${owner === 'sender' ? 'receiver' : 'sender'}Hex`]: 'cc'.repeat(32) },
  })

  it('two wallets on one host each adopt only their own unscoped records', async () => {
    const storage = new MemoryStorage()
    const legacy = new ArkadeIntentsStore(storage)
    await legacy.put(owned('rfq-a', 'sender', 'aa'.repeat(32)))
    await legacy.linkPaymentHash('aa11', 'rfq-a')
    // A receive, its key in compressed form.
    await legacy.put(owned('rfq-b', 'receiver', '02' + 'bb'.repeat(32)))
    await legacy.linkPaymentHash('bb22', 'rfq-b')
    // No key either wallet holds.
    await legacy.put(record('rfq-x', 'funded'))
    const previous = getPlatform()
    setPlatform({ storage } as never)
    try {
      const a = await ArkadeIntentsStore.forWallet(walletOf(0xaa), 'mutinynet')
      expect((await a.list()).map((r) => r.id)).toEqual(['rfq-a'])
      expect(await a.get('rfq-a')).toMatchObject({ phase: 'funded', legacyAdopted: true })
      expect(await a.idForPaymentHash('aa11')).toBe('rfq-a')
      expect(await a.idForPaymentHash('bb22')).toBeUndefined()
      // The second wallet to open still gets its own records.
      const b = await ArkadeIntentsStore.forWallet(walletOf(0xbb), 'mutinynet')
      expect((await b.list()).map((r) => r.id)).toEqual(['rfq-b'])
      expect(await b.idForPaymentHash('bb22')).toBe('rfq-b')
      // Once per scope: a record written to the unscoped keys later is not picked up.
      await legacy.put(owned('rfq-a2', 'sender', 'aa'.repeat(32)))
      expect(await (await ArkadeIntentsStore.forWallet(walletOf(0xaa), 'mutinynet')).get('rfq-a2')).toBeUndefined()
      // The unscoped keys stay where they were.
      expect((await legacy.list()).map((r) => r.id).sort()).toEqual(['rfq-a', 'rfq-a2', 'rfq-b', 'rfq-x'])
      await expect(ArkadeIntentsStore.forWallet({}, 'mutinynet')).rejects.toMatchObject({ code: 'CONFIG' })
    } finally {
      if (previous) setPlatform(previous)
    }
  })

  it("drops another wallet's record adopted by an earlier release, so its owner can adopt it", async () => {
    const storage = new MemoryStorage()
    const legacy = new ArkadeIntentsStore(storage)
    const theirs = owned('rfq-b', 'sender', 'bb'.repeat(32))
    await legacy.put(theirs)
    await legacy.linkPaymentHash('bb22', 'rfq-b')
    // What the host-wide adoption left behind: B's record copied into A's scope.
    const a = new ArkadeIntentsStore(storage, scopeA)
    await a.put({ ...theirs, legacyAdopted: true })
    await a.linkPaymentHash('bb22', 'rfq-b')
    await storage.set('arkade:intents:legacy-adopted', 'arkade:intents:mutinynet:' + 'aa'.repeat(32) + ':swap:')
    await a.adoptLegacy()
    expect(await a.get('rfq-b')).toBeUndefined()
    expect(await a.idForPaymentHash('bb22')).toBeUndefined()
    const b = new ArkadeIntentsStore(storage, { ...scopeA, walletId: 'bb'.repeat(32) })
    await b.adoptLegacy()
    expect(await b.get('rfq-b')).toMatchObject({ legacyAdopted: true })
  })

  it('claims a funding marker only when none exists, under the given lock', async () => {
    const store = new ArkadeIntentsStore(new MemoryStorage(), scopeA)
    const names: string[] = []
    const lock = async <T,>(name: string, fn: () => Promise<T>) => {
      names.push(name)
      return fn()
    }
    expect(await store.claimFundingMarker('rfq-1', { startedAt: 1 }, lock)).toBeUndefined()
    expect(await store.claimFundingMarker('rfq-1', { startedAt: 2 }, lock)).toEqual({ startedAt: 1 })
    expect(await store.getFundingMarker('rfq-1')).toEqual({ startedAt: 1 })
    expect(names).toEqual([`arkade:intents:mutinynet:${'aa'.repeat(32)}:funding:rfq-1`, `arkade:intents:mutinynet:${'aa'.repeat(32)}:funding:rfq-1`])
    await store.removeFundingMarker('rfq-1')
    expect(await store.listFundingMarkers()).toEqual(new Map())
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
