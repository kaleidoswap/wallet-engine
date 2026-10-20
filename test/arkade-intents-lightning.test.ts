/**
 * Lightning on Arkade over Arkade Intents, against a mocked solver venue:
 * two-step send (quote moves nothing, execute funds), receive + claim,
 * refunds, failures, network checks, the fee ceiling and refusal typing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArkadeAdapter } from '../src/adapters/ArkadeAdapter'
import { ArkadeWdkAdapter } from '../src/adapters/wdk/ArkadeWdkAdapter'
import { arkadeClientManager } from '../src/lib/arkade-client-manager'
import { arkadeIntentsClientManager } from '../src/lib/arkade-intents-client-manager'
import {
  ArkadeIntentsLightning,
  ArkadeIntentsRefusalError,
  FUNDING_MARGIN_SECONDS,
  UNKNOWN_LOCKUP_GRACE_SECONDS,
  lightningHrpsForArkadeNetwork,
  transactionStatusOf,
} from '../src/lib/arkade-intents-lightning'
import { ArkadeIntentsStore, type ArkadeIntentsRecord } from '../src/swap/arkade-intents-store'
import { getCapabilities } from '../src/capabilities'
import { PROTOCOL_OPERATIONS, liveOperationAvailable } from '../src/capabilities/operations'
import { CrossProtocolRouter } from '../src/router'
import { ProtocolAdapterRegistry } from '../src/adapters/IProtocolAdapter'
import type { IStorageProvider } from '../src/ports'

// Real signet invoices (decoded by the engine; never paid here).
const INV_5000 =
  'lntbs50u1p4d8ftcpp5556agcf7rvdn8z0hvce7l7x4umn4l8qhf55vpf50wxsk5w20whnsdqqcqzzsxqyz5vqsp55tcvst3kjstwxqmt5ntkm7gp0lfsptuqyu28tztrua55274s6ans9qxpqysgq22297fq2plunluc75djhthge7ncsafvxgkuds7qltcv6y3pqshs8pegg37duhem0zevcas6uuqjhvlwcpqgm0ewnu9yeqk2zr2vekkgqxcuyde'
const HASH_5000 = 'a535d4613e1b1b3389f76633eff8d5e6e75f9c174d28c0a68f71a16a394f75e7'
const INV_1000 =
  'lntbs10u1p4tplctsp56ctf30jgccvj0xlm8egpw4h4jjakdusmvaxsguunx237dfsp6vlqpp5gda3p6a96u5wvj0klg3ddnuzf65r249ygjk7arfh3su8ykhr8kxsdqqxqy9gcqcqzpc9qyysgqtr8rql6jgxz2e0kcyztaxux46038xw0y2gfgmsxrkvkc6yscdw655suwjzl04zhn02v2w9t0ncv0jlr80cyqzdamsddjqx35mtrvx5qq77snxn'
const HASH_1000 = '437b10eba5d728e649f6fa22d6cf824ea83554a444adee8d378c38725ae33d8d'
const NOW = 1_790_000_000 // before both invoices expire
const SEND_ROUTE = 'arkade:BTC->lightning:BTC'
const RECV_ROUTE = 'lightning:BTC->arkade:BTC'
const LOCKUP = 'tark1qlockup'
const LOCKUP_SCRIPT = '5120' + '11'.repeat(32)

function memoryStorage(): IStorageProvider {
  const m = new Map<string, string>()
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
    keys: async () => [...m.keys()],
  }
}

/** A solver venue double with the real venue's record lifecycle. */
function fakeVenue(store: ArkadeIntentsStore, opts: { feeSats?: number; refuse?: unknown } = {}) {
  const fee = opts.feeSats ?? 50
  let n = 0
  const venue = {
    prepareLightningSend: vi.fn(async ({ invoice }: { invoice: { amountSats: number; raw: string } }) => {
      if (opts.refuse) throw opts.refuse
      const id = `rfq-send-${++n}`
      const record = {
        id,
        route: SEND_ROUTE,
        phase: 'prepared',
        createdAt: NOW,
        quote: { valid_until: NOW + 60, refund_locktime: NOW + 3600, from_amount: invoice.amountSats + fee, to_amount: invoice.amountSats },
        address: LOCKUP,
        swapPkScriptHex: LOCKUP_SCRIPT,
        fundAmountSats: invoice.amountSats + fee,
        invoice: invoice.raw,
      } as unknown as ArkadeIntentsRecord
      await store.put(record)
      return {
        record,
        summary: { rfqId: id, fromAmountSats: invoice.amountSats + fee, toAmountSats: invoice.amountSats, feeSats: fee, validUntil: NOW + 60, refundLocktime: NOW + 3600, solverPubkey: '02ab' },
        address: LOCKUP,
        fundAmountSats: invoice.amountSats + fee,
      }
    }),
    prepareLightningReceive: vi.fn(async (args: { amountSats: number; amountSide: 'from' | 'to'; maxPayAmountSats: number; decodeInvoice: (s: string) => { amountSats: number; expiresAt: number } }) => {
      if (opts.refuse) throw opts.refuse
      const facts = args.decodeInvoice(INV_1000)
      if (facts.amountSats > args.maxPayAmountSats) throw new Error('pay amount above cap')
      const id = `rfq-recv-${++n}`
      const credited = args.amountSide === 'from' ? facts.amountSats - 10 : args.amountSats
      const record = {
        id,
        route: RECV_ROUTE,
        phase: 'prepared',
        createdAt: NOW,
        quote: { valid_until: NOW + 60, from_amount: facts.amountSats, to_amount: credited },
        address: 'tark1qhtlc',
        invoice: INV_1000,
        payAmountSats: facts.amountSats,
        expectedAmountSats: credited,
        invoiceExpiresAt: facts.expiresAt,
      } as unknown as ArkadeIntentsRecord
      await store.put(record)
      return { record, summary: { toAmountSats: credited }, invoice: INV_1000, payAmountSats: facts.amountSats, invoiceExpiresAt: facts.expiresAt }
    }),
    notifyFunded: vi.fn(async (id: string, txid?: string) => {
      const r = (await store.get(id))!
      const next = { ...r, phase: 'funded', ...(txid ? { fundingTxid: txid } : {}) } as ArkadeIntentsRecord
      await store.put(next)
      return next
    }),
    refundSend: vi.fn(async (id: string) => {
      const r = (await store.get(id))!
      const next = { ...r, phase: 'refunded', resolvedTxid: 'refund-tx' } as ArkadeIntentsRecord
      await store.put(next)
      return next
    }),
    reconcile: vi.fn(async () => ({ settled: [], refunded: [], cancelled: [], needsRecovery: [], failed: [], pending: [], errors: [] })),
    /** Test hook: what the solver/chain did since the last pass. */
    async resolve(id: string, phase: string, extra: Record<string, unknown> = {}) {
      const r = (await store.get(id))!
      await store.put({ ...r, phase, ...extra } as ArkadeIntentsRecord)
    },
  }
  return venue
}

function setup(o: { network?: string; feeSats?: number; refuse?: unknown; maxFeeBps?: number; card?: unknown; covclaimdPubkey?: string; now?: () => number; store?: ArkadeIntentsStore; wallet?: unknown } = {}) {
  const store = o.store ?? new ArkadeIntentsStore(memoryStorage())
  const venue = fakeVenue(store, o)
  vi.spyOn(arkadeIntentsClientManager, 'isInitialized').mockReturnValue(true)
  vi.spyOn(arkadeIntentsClientManager, 'getVenue').mockReturnValue(venue as never)
  const fund = vi.fn(async () => 'fund-txid')
  const fetch = vi.fn(async () =>
    o.card ? new Response(JSON.stringify(o.card), { status: 200 }) : new Response('', { status: 404 }),
  )
  const intents = new ArkadeIntentsLightning({
    config: { solverUrl: 'https://solver.test/v2', fetch: fetch as never, maxFeeBps: o.maxFeeBps, covclaimdPubkey: o.covclaimdPubkey },
    getWallet: () => o.wallet ?? {},
    fund,
    getNetwork: async () => o.network ?? 'mutinynet',
    arkServerUrl: 'https://ark.test',
    now: o.now ?? (() => NOW),
    store,
  })
  return { store, venue, fund, fetch, intents }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW * 1000)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Ark -> Lightning (two-step send)', () => {
  it('quote persists the swap and moves nothing', async () => {
    const { intents, fund, store } = setup()
    const q = await intents.quoteSend(`lightning:${INV_5000}`)
    expect(q).toMatchObject({
      paymentHash: HASH_5000,
      invoiceAmountSats: 5000,
      fundAmountSats: 5050,
      feeSats: 50,
      maxFeeSats: 150, // 300 bps default
      validUntil: NOW + 60,
      refundLocktime: NOW + 3600,
    })
    expect(fund).not.toHaveBeenCalled()
    expect((await intents.getSwap(q.id))?.status).toBe('quoted')
    expect(await store.idForPaymentHash(HASH_5000)).toBe(q.id)
  })

  it('execute funds exactly the quoted lockup and reports pending, never confirmed', async () => {
    const { intents, fund, venue } = setup()
    const q = await intents.quoteSend(INV_5000)
    const swap = await intents.executeSend(q.id)
    expect(fund).toHaveBeenCalledWith(LOCKUP, 5050)
    expect(venue.notifyFunded).toHaveBeenCalledWith(q.id, 'fund-txid')
    expect(swap).toMatchObject({ status: 'pending', fundingTxid: 'fund-txid', direction: 'send' })
    expect(transactionStatusOf(swap.status)).toBe('pending')
    // A quote funds once.
    await expect(intents.executeSend(q.id)).rejects.toMatchObject({ code: 'QUOTE_USED' })
    expect(fund).toHaveBeenCalledTimes(1)
  })

  it('settles, refunds and fails through reconcile; status follows the record', async () => {
    const { intents, venue } = setup()
    const a = await intents.quoteSend(INV_5000)
    await intents.executeSend(a.id)
    await venue.resolve(a.id, 'settled', { resolvedTxid: 'claim' })
    expect(await intents.findByPaymentHash(HASH_5000)).toMatchObject({ status: 'settled', resolvedTxid: 'claim' })
    expect(transactionStatusOf('settled')).toBe('confirmed')

    const b = await intents.quoteSend(INV_1000, { maxFeeSats: 100 })
    await intents.executeSend(b.id)
    expect((await intents.refundSend(b.id)).status).toBe('refunded')
    expect(transactionStatusOf('refunded')).toBe('failed')

    await venue.resolve(b.id, 'failed', { failureReason: 'solver vanished' })
    expect(await intents.getSwap(b.id)).toMatchObject({ status: 'failed', failureReason: 'solver vanished' })
    await venue.resolve(b.id, 'needs_recovery')
    expect((await intents.getSwap(b.id))?.status).toBe('needs_recovery')
    expect(transactionStatusOf('needs_recovery')).toBe('pending')
  })

  it('refuses an expired quote without funding', async () => {
    const { intents, fund } = setup()
    const q = await intents.quoteSend(INV_5000)
    ;(intents as any).deps.now = () => NOW + 61
    await expect(intents.executeSend(q.id)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
    expect(fund).not.toHaveBeenCalled()
  })

  it('a funding failure never funds the quote again, and ends cancelled once the lockup stays empty', async () => {
    let now = NOW
    const getVtxos = vi.fn(async () => ({ vtxos: [] as unknown[] }))
    const { intents, fund, venue, store } = setup({ now: () => now, wallet: { indexerProvider: { getVtxos } } })
    fund.mockRejectedValueOnce(new Error('insufficient funds'))
    const q = await intents.quoteSend(INV_5000)
    await expect(intents.executeSend(q.id)).rejects.toThrow('insufficient funds')
    expect(venue.notifyFunded).not.toHaveBeenCalled()
    // The call may have broadcast before it threw: the quote counts as funded.
    expect(await store.getFundingMarker(q.id)).toMatchObject({ error: 'insufficient funds' })
    expect((await intents.getSwap(q.id))?.status).toBe('pending')
    await expect(intents.executeSend(q.id)).rejects.toMatchObject({ code: 'QUOTE_USED' })
    await expect(intents.quoteSend(INV_5000)).rejects.toMatchObject({ code: 'INVOICE_IN_PROGRESS' })
    expect(fund).toHaveBeenCalledTimes(1)

    // An empty lockup inside the grace window may still be the indexer lagging.
    now = q.validUntil + UNKNOWN_LOCKUP_GRACE_SECONDS - 1
    await intents.reconcile()
    expect(getVtxos).toHaveBeenCalledWith({ scripts: [LOCKUP_SCRIPT] })
    expect((await intents.getSwap(q.id))?.status).toBe('pending')

    // Past it, the funding never landed: the swap ends and the invoice is free.
    now = q.validUntil + UNKNOWN_LOCKUP_GRACE_SECONDS
    await intents.reconcile()
    expect(await store.getFundingMarker(q.id)).toBeUndefined()
    expect(await intents.getSwap(q.id)).toMatchObject({ status: 'cancelled', phase: 'cancelled' })
    await expect(intents.quoteSend(INV_5000)).rejects.toMatchObject({ kind: 'already_quoted' })
    expect(fund).toHaveBeenCalledTimes(1)
  })

  it('a funding call that threw after the lockup landed becomes a refundable funded swap', async () => {
    const getVtxos = vi.fn(async () => ({ vtxos: [{ txid: 'lockup-tx', vout: 0 }] }))
    const { intents, fund, venue, store } = setup({ wallet: { indexerProvider: { getVtxos } } })
    fund.mockRejectedValueOnce(new Error('timeout'))
    const q = await intents.quoteSend(INV_5000)
    await expect(intents.executeSend(q.id)).rejects.toThrow('timeout')
    // The venue gave up on it (e.g. a lagging indexer) before the lockup showed.
    await venue.resolve(q.id, 'cancelled')
    await intents.reconcile()
    expect(await store.get(q.id)).toMatchObject({ phase: 'funded' })
    expect(await intents.refundSend(q.id)).toMatchObject({ status: 'refunded' })
    expect(venue.refundSend).toHaveBeenCalledWith(q.id)
  })

  it('an unreadable lockup leaves the marker for the next pass', async () => {
    let now = NOW
    const { intents, fund, store } = setup({ now: () => now })
    fund.mockRejectedValueOnce(new Error('insufficient funds'))
    const q = await intents.quoteSend(INV_5000)
    await expect(intents.executeSend(q.id)).rejects.toThrow()
    now = NOW + 3600
    // No indexer on the wallet.
    await intents.reconcile()
    expect(await store.getFundingMarker(q.id)).toBeDefined()
    expect(await store.get(q.id)).toMatchObject({ phase: 'prepared' })
  })

  it('drops the funding markers of swaps that ended', async () => {
    const { intents, venue, store } = setup()
    const a = await intents.quoteSend(INV_5000)
    await intents.executeSend(a.id)
    const b = await intents.quoteSend(INV_1000, { maxFeeSats: 100 })
    await intents.executeSend(b.id)
    await intents.refundSend(b.id)
    // A refunded invoice is no longer in progress, even before the marker is pruned.
    await expect(intents.quoteSend(INV_1000)).rejects.toMatchObject({ kind: 'already_quoted' })
    await venue.resolve(a.id, 'settled')
    await intents.reconcile()
    expect(await store.listFundingMarkers()).toEqual(new Map())
    expect((await intents.getSwap(a.id))?.status).toBe('settled')
    expect((await intents.getSwap(b.id))?.status).toBe('refunded')
  })

  it('stays pending when funded but the hand-off fails', async () => {
    const { intents, venue } = setup()
    venue.notifyFunded.mockRejectedValueOnce(new Error('manager offline'))
    const q = await intents.quoteSend(INV_5000)
    expect(await intents.executeSend(q.id)).toMatchObject({ status: 'pending', fundingTxid: 'fund-txid' })
  })

  it('enforces the fee ceiling (config bps or the caller maxFeeSats)', async () => {
    const { intents } = setup({ feeSats: 200 })
    await expect(intents.quoteSend(INV_5000)).rejects.toMatchObject({ code: 'FEE_TOO_HIGH' })
    await expect(intents.quoteSend(INV_5000, { maxFeeSats: 10 })).rejects.toMatchObject({ code: 'FEE_TOO_HIGH' })
    expect((await intents.quoteSend(INV_5000, { maxFeeSats: 200 })).feeSats).toBe(200)
  })

  it('rejects an invoice for another network before asking the solver', async () => {
    const { intents, venue } = setup({ network: 'bitcoin' })
    await expect(intents.quoteSend(INV_5000)).rejects.toMatchObject({ code: 'INVOICE_NETWORK_MISMATCH' })
    expect(venue.prepareLightningSend).not.toHaveBeenCalled()
    expect(lightningHrpsForArkadeNetwork('mutinynet')).toEqual(['tbs'])
    expect(lightningHrpsForArkadeNetwork('bitcoin')).toEqual(['bc'])
  })

  it('rejects expired invoices', async () => {
    const { intents } = setup()
    ;(intents as any).deps.now = () => 1_792_341_753
    await expect(intents.quoteSend(INV_5000)).rejects.toMatchObject({ code: 'INVOICE_EXPIRED' })
  })
})

describe('funding safety', () => {
  it('concurrent executeSend calls fund the lockup once', async () => {
    const { intents, fund, store } = setup()
    let release!: () => void
    fund.mockImplementationOnce(() => new Promise<string>((done) => (release = () => done('fund-txid'))))
    const q = await intents.quoteSend(INV_5000)
    const first = intents.executeSend(q.id)
    const second = intents.executeSend(q.id)
    // Another engine instance on the same wallet (e.g. the other adapter).
    const other = new ArkadeIntentsLightning({
      config: { solverUrl: 'https://solver.test/v2' },
      getWallet: () => ({}),
      fund,
      getNetwork: async () => 'mutinynet',
      arkServerUrl: 'https://ark.test',
      now: () => NOW,
      store,
    })
    const third = other.executeSend(q.id)
    await vi.waitFor(() => expect(fund).toHaveBeenCalledTimes(1))
    // A re-quote while funding is in flight is not handed the same quote to fund.
    await expect(intents.quoteSend(INV_5000)).rejects.toMatchObject({ code: 'INVOICE_IN_PROGRESS' })
    release()
    const results = await Promise.all([first, second, third])
    expect(results.map((r) => r.fundingTxid)).toEqual(['fund-txid', 'fund-txid', 'fund-txid'])
    expect(fund).toHaveBeenCalledTimes(1)
    await expect(intents.executeSend(q.id)).rejects.toMatchObject({ code: 'QUOTE_USED' })
  })

  it('two contexts sharing storage fund once under the Web Locks API', async () => {
    // Each context loads its own copy of the engine, so no module state is shared;
    // only the storage and the origin-wide lock manager are.
    const held = new Map<string, Promise<unknown>>()
    const locks = {
      request: async (name: string, fn: () => Promise<unknown>) => {
        while (held.has(name)) await held.get(name)!.catch(() => {})
        const run = fn()
        held.set(name, run)
        try {
          return await run
        } finally {
          held.delete(name)
        }
      },
    }
    vi.stubGlobal('navigator', { locks })
    const storage = memoryStorage()
    let release!: () => void
    const fund = vi.fn(() => new Promise<string>((done) => (release = () => done('fund-txid'))))
    const context = async () => {
      vi.resetModules()
      const lightning = await import('../src/lib/arkade-intents-lightning')
      const { ArkadeIntentsStore: Store } = await import('../src/swap/arkade-intents-store')
      const { arkadeIntentsClientManager: manager } = await import('../src/lib/arkade-intents-client-manager')
      const store = new Store(storage, { network: 'mutinynet', walletId: 'aa'.repeat(32) })
      const venue = fakeVenue(store)
      vi.spyOn(manager, 'isInitialized').mockReturnValue(true)
      vi.spyOn(manager, 'getVenue').mockReturnValue(venue as never)
      const intents = new lightning.ArkadeIntentsLightning({
        config: { solverUrl: 'https://solver.test/v2', fetch: (async () => new Response('', { status: 404 })) as never },
        getWallet: () => ({}),
        fund,
        getNetwork: async () => 'mutinynet',
        arkServerUrl: '',
        now: () => NOW,
        store,
      })
      return { intents, lightning }
    }
    try {
      const popup = await context()
      const worker = await context()
      expect(popup.lightning).not.toBe(worker.lightning)
      const q = await popup.intents.quoteSend(INV_5000)
      const attempts = Promise.allSettled([popup.intents.executeSend(q.id), worker.intents.executeSend(q.id)])
      await vi.waitFor(() => expect(fund).toHaveBeenCalledTimes(1))
      release()
      const [first, second] = await attempts
      expect(first).toMatchObject({ status: 'fulfilled', value: { status: 'pending', fundingTxid: 'fund-txid' } })
      expect(second).toMatchObject({ status: 'rejected', reason: { code: 'QUOTE_USED' } })
      expect(fund).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a funding marker persisted by another process blocks funding', async () => {
    const { intents, fund, store } = setup()
    const q = await intents.quoteSend(INV_5000)
    await store.setFundingMarker(q.id, { startedAt: NOW })
    await expect(intents.executeSend(q.id)).rejects.toMatchObject({ code: 'QUOTE_USED' })
    expect(fund).not.toHaveBeenCalled()
  })

  it('after a failed notifyFunded the txid is persisted and the swap stays refundable', async () => {
    const { intents, venue, store, fund } = setup()
    venue.notifyFunded.mockRejectedValueOnce(new Error('manager offline'))
    const q = await intents.quoteSend(INV_5000)
    expect(await intents.executeSend(q.id)).toMatchObject({ status: 'pending', fundingTxid: 'fund-txid' })
    expect(await store.getFundingMarker(q.id)).toMatchObject({ fundingTxid: 'fund-txid' })
    // The record itself is moved to funded, so the venue tracks it.
    expect(await store.get(q.id)).toMatchObject({ phase: 'funded', fundingTxid: 'fund-txid' })
    await expect(intents.quoteSend(INV_5000)).rejects.toMatchObject({ code: 'INVOICE_IN_PROGRESS' })
    await expect(intents.executeSend(q.id)).rejects.toMatchObject({ code: 'QUOTE_USED' })
    expect(fund).toHaveBeenCalledTimes(1)

    // Even if the venue later cancels the record (lagging indexer), refund still runs.
    await venue.resolve(q.id, 'cancelled')
    expect((await intents.getSwap(q.id))?.status).toBe('pending')
    expect(await intents.refundSend(q.id)).toMatchObject({ status: 'refunded' })
    expect(venue.refundSend).toHaveBeenCalledWith(q.id)
  })

  it('reconcile hands a funded send the venue never heard of back to it', async () => {
    const { intents, venue, store } = setup()
    venue.notifyFunded.mockRejectedValueOnce(new Error('store down'))
    const q = await intents.quoteSend(INV_5000)
    const put = vi.spyOn(store, 'put').mockRejectedValueOnce(new Error('store down'))
    await intents.executeSend(q.id)
    put.mockRestore()
    expect(await store.get(q.id)).toMatchObject({ phase: 'prepared' })
    await intents.reconcile()
    expect(await store.get(q.id)).toMatchObject({ phase: 'funded', fundingTxid: 'fund-txid' })
  })

  it('refuses to fund a quote too close to its expiry', async () => {
    let now = NOW
    const { intents, fund } = setup({ now: () => now })
    const q = await intents.quoteSend(INV_5000)
    now = q.validUntil - FUNDING_MARGIN_SECONDS
    await expect(intents.executeSend(q.id)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
    // Nor is it handed back on a re-quote.
    await expect(intents.quoteSend(INV_5000)).rejects.toMatchObject({ kind: 'already_quoted' })
    expect(fund).not.toHaveBeenCalled()
    now = q.validUntil - FUNDING_MARGIN_SECONDS - 1
    expect(await intents.executeSend(q.id)).toMatchObject({ status: 'pending' })
  })

  it('re-checks the fee against fundAmountSats before funding', async () => {
    const { intents, fund, store } = setup()
    const q = await intents.quoteSend(INV_5000)
    const record = (await store.get(q.id))!
    await store.put({ ...record, fundAmountSats: 6000 })
    await expect(intents.executeSend(q.id)).rejects.toMatchObject({ code: 'FEE_TOO_HIGH' })
    expect(fund).not.toHaveBeenCalled()
  })

  it('executeSend honours the ceiling approved at quote time', async () => {
    const { intents, fund } = setup({ feeSats: 200 })
    const q = await intents.quoteSend(INV_5000, { maxFeeSats: 200 })
    expect(await intents.executeSend(q.id)).toMatchObject({ status: 'pending' })
    expect(fund).toHaveBeenCalledWith(LOCKUP, 5200)
  })

  it('fails closed on an empty or unknown Ark network', async () => {
    expect(lightningHrpsForArkadeNetwork('')).toBeNull()
    for (const network of ['', 'liquid']) {
      await expect(setup({ network }).intents.quoteSend(INV_5000)).rejects.toMatchObject({ code: 'INVOICE_NETWORK_MISMATCH' })
    }
  })

  it("createReceive('from') refuses a quote that does not state the credited amount", async () => {
    const { intents, venue } = setup()
    const real = venue.prepareLightningReceive.getMockImplementation()!
    venue.prepareLightningReceive.mockImplementationOnce(async (args) => ({ ...(await real(args)), summary: {} }))
    await expect(intents.createReceive(1000, { amountSide: 'from' })).rejects.toMatchObject({ code: 'INVALID_QUOTE' })
    expect(venue.notifyFunded).not.toHaveBeenCalled()
  })
})

describe('solver refusals are typed', () => {
  const card = { markets: [{ quote_corridor: 'lightning', fee_bps: 100, min_quote_amount: '10000', max_quote_amount: '1082994' }] }

  it('below the published minimum: refused locally with the limit, solver never asked', async () => {
    const { intents, venue, fetch } = setup({ card })
    const err = await intents.quoteSend(INV_5000).catch((e) => e)
    expect(fetch).toHaveBeenCalledWith('https://solver.test/v1/card') // sibling of the /v2 base
    expect(err).toBeInstanceOf(ArkadeIntentsRefusalError)
    expect(err).toMatchObject({ code: 'INTENTS_REFUSED', reason: 'amount_out_of_range', kind: 'below_minimum', actual: 5000, limit: 10000 })
    expect(venue.prepareLightningSend).not.toHaveBeenCalled()
  })

  it('maps a SwapRefusal whose limits were dropped upstream', async () => {
    const refusal = Object.assign(new Error('solver refused: amount_out_of_range'), { reason: 'amount_out_of_range', rfqId: 'x' })
    const { intents } = setup({ refuse: refusal })
    // No card: the reason survives with an unknown range.
    expect(await intents.quoteSend(INV_5000).catch((e) => e)).toMatchObject({ reason: 'amount_out_of_range', kind: 'out_of_range' })
  })

  it('maps exposure_cap to no_capacity and keeps upstream limit fields', async () => {
    const refusal = Object.assign(new Error('solver refused: exposure_cap'), { reason: 'exposure_cap', limit: 0, unit: 'sats', errorCode: 'E1' })
    const { intents } = setup({ refuse: refusal })
    expect(await intents.createReceive(1000).catch((e) => e)).toMatchObject({ reason: 'exposure_cap', kind: 'no_capacity', limit: 0, errorCode: 'E1' })
  })

  it('passes non-refusal errors through untouched', async () => {
    const { intents } = setup({ refuse: new Error('network down') })
    await expect(intents.quoteSend(INV_5000)).rejects.toThrow('network down')
  })
})

describe('Lightning -> Ark (receive + claim)', () => {
  it('returns the solver BOLT11, indexes it and arms the claim watcher', async () => {
    const { intents, venue, fund } = setup()
    const r = await intents.createReceive(990)
    expect(r).toMatchObject({ invoice: INV_1000, paymentHash: HASH_1000, payAmountSats: 1000, expectedAmountSats: 990, feeSats: 10 })
    expect(venue.prepareLightningReceive.mock.calls[0][0]).toMatchObject({ amountSats: 990, amountSide: 'to', maxPayAmountSats: 990 + 30 })
    expect(venue.notifyFunded).toHaveBeenCalledWith(r.id)
    expect(fund).not.toHaveBeenCalled() // the payer is external
    expect((await intents.findByPaymentHash(HASH_1000))?.status).toBe('pending')
    await venue.resolve(r.id, 'settled', { resolvedTxid: 'claim-tx' })
    expect(await intents.findByPaymentHash(HASH_1000)).toMatchObject({ status: 'settled', direction: 'receive', resolvedTxid: 'claim-tx' })
  })

  it('reconcile drives claims and refunds and survives a restart (state is in the store)', async () => {
    const { intents, venue, store } = setup()
    const r = await intents.createReceive(990)
    await intents.reconcile()
    expect(venue.reconcile).toHaveBeenCalled()
    // A new engine instance over the same storage sees the pending claim.
    const again = new ArkadeIntentsLightning({ config: {}, getWallet: () => ({}), fund: vi.fn(), getNetwork: async () => 'mutinynet', arkServerUrl: '', store, now: () => NOW })
    expect((await again.listSwaps()).map((s) => [s.id, s.status])).toContainEqual([r.id, 'pending'])
  })

  it('validates the configured covclaimd key', async () => {
    const { intents } = setup({ covclaimdPubkey: 'not-hex' })
    await expect(intents.createReceive(990)).rejects.toMatchObject({ code: 'CONFIG' })
    const ok = setup({ covclaimdPubkey: '02' + 'ab'.repeat(32) })
    await ok.intents.createReceive(990)
    expect(ok.venue.prepareLightningReceive.mock.calls[0][0].covclaimdPubkey).toBeInstanceOf(Uint8Array)
  })

  it("amountSide 'from' fixes the invoice amount and bounds the fee", async () => {
    const { intents, venue } = setup()
    const r = await intents.createReceive(1000, { amountSide: 'from' })
    expect(venue.prepareLightningReceive.mock.calls[0][0]).toMatchObject({ amountSats: 1000, amountSide: 'from', maxPayAmountSats: 1000 })
    expect(r).toMatchObject({ payAmountSats: 1000, expectedAmountSats: 990, feeSats: 10 })
    await expect(setup().intents.createReceive(1000, { amountSide: 'from', maxFeeSats: 5 })).rejects.toMatchObject({ code: 'FEE_TOO_HIGH' })
    // The solver must quote the exact amount asked for.
    await expect(setup().intents.createReceive(990, { amountSide: 'from' })).rejects.toThrow()
  })

  it('requires an amount', async () => {
    const { intents } = setup()
    await expect(intents.createReceive(0)).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
  })
})

describe('without a venue', () => {
  it('fails with NOT_CONFIGURED and moves nothing', async () => {
    vi.spyOn(arkadeIntentsClientManager, 'isInitialized').mockReturnValue(false)
    const fund = vi.fn()
    const intents = new ArkadeIntentsLightning({ config: { enabled: false }, getWallet: () => ({}), fund, getNetwork: async () => 'mutinynet', arkServerUrl: '' })
    expect(intents.isAvailable()).toBe(false)
    await expect(intents.quoteSend(INV_5000)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    expect(fund).not.toHaveBeenCalled()
  })
})

// --- adapters ---------------------------------------------------------------

function wallet() {
  return { getAddress: vi.fn(async () => 'tark1qreceiver'), sendBitcoin: vi.fn(async () => 'txid') }
}

function nativeAdapter(intents: ArkadeIntentsLightning) {
  vi.spyOn(arkadeClientManager, 'isInitialized').mockReturnValue(true)
  vi.spyOn(arkadeClientManager, 'getWallet').mockReturnValue(wallet() as never)
  return Object.assign(new ArkadeAdapter(), { intents }) as ArkadeAdapter
}

function wdkAdapter(intents: ArkadeIntentsLightning) {
  return Object.assign(new ArkadeWdkAdapter(), { connected: true, wallet: wallet(), intents }) as ArkadeWdkAdapter
}

describe('adapters route Lightning through Intents', () => {
  for (const [name, make] of [
    ['ArkadeAdapter', nativeAdapter],
    ['ArkadeWdkAdapter', wdkAdapter],
  ] as const) {
    it(`${name}: sendPayment(bolt11) quotes, funds the lockup and reports pending`, async () => {
      const { intents, fund } = setup()
      const adapter = make(intents)
      const res = await adapter.sendPayment({ invoice: `lightning:${INV_5000}` })
      expect(res).toMatchObject({ paymentHash: HASH_5000, txid: 'fund-txid', amount: 5000, fee: 50, status: 'pending' })
      expect(fund).toHaveBeenCalledWith(LOCKUP, 5050)
      expect((await adapter.getPaymentStatus(HASH_5000)).status).toBe('pending')
    })

    it(`${name}: sendPayment honours maxFeeSats before funding`, async () => {
      const { intents, fund } = setup()
      const adapter = make(intents)
      await expect(adapter.sendPayment({ invoice: INV_5000, maxFeeSats: 10 })).rejects.toMatchObject({ code: 'FEE_TOO_HIGH' })
      expect(fund).not.toHaveBeenCalled()
    })

    it(`${name}: createInvoice(BTC_LN) returns the solver BOLT11, not an Ark address`, async () => {
      const { intents } = setup()
      const adapter = make(intents)
      const inv = await adapter.createInvoice({ amount: 1000, layer: 'BTC_LN' })
      // The invoice is for exactly the requested amount; the fee comes off the Ark side.
      expect(inv).toMatchObject({ invoice: INV_1000, paymentHash: HASH_1000, amount: 1000 })
      expect((intents as any).deps.store).toBeDefined()
      expect(inv.invoice.startsWith('lntbs')).toBe(true)
    })

    it(`${name}: two-step API and live capabilities`, async () => {
      const { intents, fund } = setup()
      const adapter = make(intents) as any
      expect(adapter.capabilities).toContain('lightning-send')
      expect(adapter.capabilities).toContain('lightning-receive')
      const q = await adapter.quoteLightningSend(INV_5000)
      expect(fund).not.toHaveBeenCalled()
      expect((await adapter.executeLightningSend(q.id)).status).toBe('pending')
      expect(await adapter.listLightningSwaps()).toHaveLength(1)
    })
  }

  it('capabilities drop Lightning while no venue is live', () => {
    vi.spyOn(arkadeIntentsClientManager, 'isInitialized').mockReturnValue(false)
    const adapter = new ArkadeWdkAdapter()
    expect(adapter.capabilities).not.toContain('lightning-send')
    expect(adapter.capabilities).not.toContain('lightning-receive')
  })
})

describe('manifest and router', () => {
  it('ARKADE declares Lightning statically, gated per connection', () => {
    const caps = getCapabilities('ARKADE')
    expect(caps.supportsLightning).toBe(true)
    expect(caps.layers).toContain('BTC_LN')
    expect(PROTOCOL_OPERATIONS.ARKADE).not.toContain('lightning-send')
    expect(liveOperationAvailable('ARKADE', 'lightning-send', PROTOCOL_OPERATIONS.ARKADE)).toBe(false)
    expect(liveOperationAvailable('SPARK', 'lightning-send', [])).toBe(true)
  })

  it('routes a bolt11 directly to ARKADE only when its adapter offers lightning-send', () => {
    const route = (capabilities: readonly string[]) => {
      const registry = new ProtocolAdapterRegistry()
      registry.register({ protocolName: 'ARKADE', isConnected: () => true, capabilities } as never)
      return new CrossProtocolRouter(registry).resolveSend(INV_5000).routes.filter((r) => r.protocol === 'ARKADE' && r.direct)
    }
    expect(route(PROTOCOL_OPERATIONS.ARKADE)).toHaveLength(0)
    expect(route([...PROTOCOL_OPERATIONS.ARKADE, 'lightning-send'])).toHaveLength(1)
  })
})
