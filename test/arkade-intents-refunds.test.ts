/**
 * Arkade Intents refunds, Ark -> LN, against a mocked solver/Ark operator.
 *
 * The KaleidoSwap maker never refunds an Arkade lockup itself: when its
 * Lightning payment fails it marks the deposit taker-refundable, and the
 * trader takes it back with `refundWithoutReceiver` (trader + Ark operator)
 * once `refund_locktime` (quote + ~25 h) has passed. A solver that does spend
 * the lockup back early (the covenant `nonInteractiveRefund`) is modelled too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { arkadeIntentsClientManager } from '../src/lib/arkade-intents-client-manager'
import { ArkadeIntentsLightning, REFUND_MTP_LAG_SECONDS, transactionStatusOf } from '../src/lib/arkade-intents-lightning'
import { ArkadeIntentsStore, type ArkadeIntentsRecord } from '../src/swap/arkade-intents-store'
import type { IStorageProvider } from '../src/ports'

const INV_5000 =
  'lntbs50u1p4d8ftcpp5556agcf7rvdn8z0hvce7l7x4umn4l8qhf55vpf50wxsk5w20whnsdqqcqzzsxqyz5vqsp55tcvst3kjstwxqmt5ntkm7gp0lfsptuqyu28tztrua55274s6ans9qxpqysgq22297fq2plunluc75djhthge7ncsafvxgkuds7qltcv6y3pqshs8pegg37duhem0zevcas6uuqjhvlwcpqgm0ewnu9yeqk2zr2vekkgqxcuyde'
const INV_1000 =
  'lntbs10u1p4tplctsp56ctf30jgccvj0xlm8egpw4h4jjakdusmvaxsguunx237dfsp6vlqpp5gda3p6a96u5wvj0klg3ddnuzf65r249ygjk7arfh3su8ykhr8kxsdqqxqy9gcqcqzpc9qyysgqtr8rql6jgxz2e0kcyztaxux46038xw0y2gfgmsxrkvkc6yscdw655suwjzl04zhn02v2w9t0ncv0jlr80cyqzdamsddjqx35mtrvx5qq77snxn'
const T0 = 1_790_000_000
const LOCKTIME = T0 + 25 * 3600 // what the maker quotes: swap TTL 24 h + 1 h
const SEND_ROUTE = 'arkade:BTC->lightning:BTC'
const RECV_ROUTE = 'lightning:BTC->arkade:BTC'

function memoryStorage(map = new Map<string, string>()): IStorageProvider {
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
    keys: async () => [...map.keys()],
  }
}

/** What the solver, the Ark operator and the chain are doing. */
interface World {
  now: number
  /** The solver's own spend of the lockup, if any. */
  solver: null | 'settled' | 'refunded'
  /** Ark operator co-signs the trader's refundWithoutReceiver. */
  operatorUp: boolean
  /** Lockup batch swept: no offchain spend possible. */
  swept: boolean
  /** Sats actually sitting at the lockup. */
  lockedSats: number | null
}

function fakeVenue(store: ArkadeIntentsStore, world: World) {
  let n = 0
  const pushes: string[] = []
  const put = async (id: string, patch: Record<string, unknown>) => {
    const r = (await store.get(id))!
    const next = { ...r, ...patch } as ArkadeIntentsRecord
    await store.put(next)
    return next
  }
  /** One manager pass over a funded send: chain first, then the trader's refund. */
  const pass = async (id: string) => {
    const r = (await store.get(id))!
    if (r.phase !== 'funded' && r.phase !== 'needs_recovery') return r
    if (world.solver === 'settled') return put(id, { phase: 'settled', resolvedTxid: 'solver-claim' })
    if (world.solver === 'refunded') return put(id, { phase: 'refunded', resolvedTxid: 'solver-refund' })
    const locktime = Number((r.quote as any).refund_locktime)
    if (world.now < locktime) return r
    if (world.swept) return put(id, { phase: 'needs_recovery', recoveryOutpoints: [`${r.fundingTxid}:0`] })
    if (!world.operatorUp) {
      if (world.now >= locktime + REFUND_MTP_LAG_SECONDS) return put(id, { phase: 'failed', failureReason: 'ark server refused the refund' })
      return r
    }
    if (world.lockedSats === 0) return put(id, { phase: 'cancelled' })
    pushes.push(id)
    return put(id, { phase: 'refunded', resolvedTxid: `refund-${pushes.length}` })
  }
  const venue = {
    pushes,
    prepareLightningSend: vi.fn(async ({ invoice }: { invoice: { amountSats: number; raw: string } }) => {
      const id = `rfq-${++n}`
      const record = {
        id,
        route: SEND_ROUTE,
        phase: 'prepared',
        createdAt: world.now,
        quote: { valid_until: world.now + 60, refund_locktime: LOCKTIME, from_amount: invoice.amountSats + 50, to_amount: invoice.amountSats },
        address: 'tark1qlockup',
        fundAmountSats: invoice.amountSats + 50,
      } as unknown as ArkadeIntentsRecord
      await store.put(record)
      return { record, summary: { rfqId: id, toAmountSats: invoice.amountSats, validUntil: world.now + 60, refundLocktime: LOCKTIME }, address: 'tark1qlockup', fundAmountSats: invoice.amountSats + 50 }
    }),
    prepareLightningReceive: vi.fn(async (args: { decodeInvoice: (s: string) => { amountSats: number; expiresAt: number } }) => {
      const facts = args.decodeInvoice(INV_1000)
      const id = `rfq-recv-${++n}`
      const record = {
        id,
        route: RECV_ROUTE,
        phase: 'prepared',
        createdAt: world.now,
        quote: { valid_until: world.now + 120, refund_locktime: world.now + 2.5 * 3600, from_amount: 1000, to_amount: 990 },
        address: 'tark1qhtlc',
        invoice: INV_1000,
        payAmountSats: 1000,
        expectedAmountSats: 990,
        invoiceExpiresAt: facts.expiresAt,
      } as unknown as ArkadeIntentsRecord
      await store.put(record)
      return { record, summary: { toAmountSats: 990 }, invoice: INV_1000, payAmountSats: 1000, invoiceExpiresAt: facts.expiresAt }
    }),
    notifyFunded: vi.fn(async (id: string, txid?: string) => put(id, { phase: 'funded', ...(txid ? { fundingTxid: txid } : {}) })),
    refundSend: vi.fn(async (id: string) => pass(id)),
    reconcile: vi.fn(async () => {
      const report = { settled: [] as string[], refunded: [] as string[], cancelled: [] as string[], needsRecovery: [] as string[], failed: [] as string[], pending: [] as string[], errors: [] }
      for (const r of await store.listPending()) {
        if (r.route === RECV_ROUTE) {
          // Unpaid hold invoice: the solver never funds; the manager ends the
          // receive once its window plus the MTP lag has passed.
          const lt = Number((r.quote as any).refund_locktime)
          if (world.now >= lt + REFUND_MTP_LAG_SECONDS) {
            await put(r.id, { phase: 'cancelled' })
            report.cancelled.push(r.id)
          } else report.pending.push(r.id)
          continue
        }
        const next = await pass(r.id)
        const bucket = next.phase === 'needs_recovery' ? 'needsRecovery' : next.phase
        ;((report as any)[bucket] ?? report.pending).push(r.id)
      }
      return report
    }),
  }
  return venue
}

function setup(over: Partial<World> = {}, storage = memoryStorage()) {
  const world: World = { now: T0, solver: null, operatorUp: true, swept: false, lockedSats: null, ...over }
  const store = new ArkadeIntentsStore(storage)
  const venue = fakeVenue(store, world)
  vi.spyOn(arkadeIntentsClientManager, 'isInitialized').mockReturnValue(true)
  vi.spyOn(arkadeIntentsClientManager, 'getVenue').mockReturnValue(venue as never)
  const fund = vi.fn(async () => 'fund-txid')
  const make = () =>
    new ArkadeIntentsLightning({
      config: { solverUrl: 'https://solver.test/v2', reconcileIntervalMs: 0, fetch: (async () => new Response('', { status: 404 })) as never },
      getWallet: () => ({}),
      fund,
      getNetwork: async () => 'mutinynet',
      arkServerUrl: 'https://ark.test',
      now: () => world.now,
      store,
    })
  return { world, store, venue, fund, intents: make(), make }
}

async function funded(s: ReturnType<typeof setup>, invoice = INV_5000) {
  const q = await s.intents.quoteSend(invoice)
  await s.intents.executeSend(q.id)
  return q
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(T0 * 1000)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Ark -> LN refunds', () => {
  it('(a) solver gives up after funding (LN payment failed) and returns the lockup: refund resolves without waiting', async () => {
    const s = setup()
    const q = await funded(s)
    s.world.solver = 'refunded' // the solver's covenant refund landed
    const swap = await s.intents.refundSend(q.id)
    expect(swap).toMatchObject({ status: 'refunded', resolvedTxid: 'solver-refund' })
    expect(transactionStatusOf(swap.status)).toBe('failed')
    expect(s.venue.pushes).toHaveLength(0) // nothing of ours was needed
  })

  it('(b) solver unresponsive: before refund_locktime refund fails REFUND_NOT_YET with the unlock time', async () => {
    const s = setup()
    const q = await funded(s)
    expect(q.refundLocktime).toBe(LOCKTIME)
    s.world.now = T0 + 90 * 60
    const err = await s.intents.refundSend(q.id).catch((e) => e)
    expect(err).toMatchObject({ code: 'REFUND_NOT_YET', refundAvailableAt: LOCKTIME })
    expect(err.message).toContain(new Date(LOCKTIME * 1000).toISOString())
    expect((await s.intents.getSwap(q.id))?.status).toBe('pending')
    expect(s.venue.pushes).toHaveLength(0)
  })

  it('(c) after refund_locktime the trader + operator refund lands', async () => {
    const s = setup()
    const q = await funded(s)
    s.world.now = LOCKTIME + 1
    expect(await s.intents.refundSend(q.id)).toMatchObject({ status: 'refunded', resolvedTxid: 'refund-1' })
  })

  it('(c) inside the median-time-past lag the push is retried, reported pending, not an error', async () => {
    const s = setup({ operatorUp: false })
    const q = await funded(s)
    s.world.now = LOCKTIME + 600
    expect((await s.intents.refundSend(q.id)).status).toBe('pending')
    s.world.operatorUp = true
    expect((await s.intents.refundSend(q.id)).status).toBe('refunded')
  })

  it('(d) operator unavailable for good after a swept batch: needs_recovery with a unilateral-exit hint', async () => {
    const s = setup({ swept: true })
    const q = await funded(s)
    s.world.now = LOCKTIME + 1
    const swap = await s.intents.refundSend(q.id)
    expect(swap.status).toBe('needs_recovery')
    expect(swap.recoveryHint).toMatch(/unilateral exit/)
    expect(transactionStatusOf(swap.status)).toBe('pending') // funds still exist
    // A further call retries rather than throwing.
    expect((await s.intents.refundSend(q.id)).status).toBe('needs_recovery')
  })

  it('(d) operator refusing past the lag ends failed with the reason', async () => {
    const s = setup({ operatorUp: false })
    const q = await funded(s)
    s.world.now = LOCKTIME + REFUND_MTP_LAG_SECONDS + 1
    expect(await s.intents.refundSend(q.id)).toMatchObject({ status: 'failed', failureReason: 'ark server refused the refund' })
  })

  it('(e) a restart resumes the refund from storage, and the background reconcile does it when due', async () => {
    const map = new Map<string, string>()
    const s = setup({}, memoryStorage(map))
    const q = await funded(s)
    s.intents.stop()
    // New process, same storage, past the locktime.
    s.world.now = LOCKTIME + 5
    const fresh = new ArkadeIntentsLightning({
      config: { solverUrl: 'https://solver.test/v2', reconcileIntervalMs: 30_000 },
      getWallet: () => ({}),
      fund: vi.fn(),
      getNetwork: async () => 'mutinynet',
      arkServerUrl: '',
      now: () => s.world.now,
      store: new ArkadeIntentsStore(memoryStorage(map)),
    })
    expect(await fresh.start()).toBe(true)
    await vi.waitFor(async () => expect((await fresh.getSwap(q.id))?.status).toBe('refunded'))
    expect(s.venue.reconcile).toHaveBeenCalledTimes(1) // the resume pass, before any tick
    fresh.stop()
  })

  it('(e) the interval reconcile refunds once the window opens, with no host call', async () => {
    const s = setup()
    const q = await funded(s)
    const bg = new ArkadeIntentsLightning({
      config: { solverUrl: 'https://solver.test/v2', reconcileIntervalMs: 30_000 },
      getWallet: () => ({}),
      fund: vi.fn(),
      getNetwork: async () => 'mutinynet',
      arkServerUrl: '',
      now: () => s.world.now,
      store: s.store,
    })
    await bg.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await bg.getSwap(q.id))?.status).toBe('pending')
    s.world.now = LOCKTIME + 1
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await bg.getSwap(q.id))?.status).toBe('refunded')
    bg.stop()
  })

  it('(f) idempotent: a double refund pushes once; settled and unfunded swaps refuse clearly', async () => {
    const s = setup()
    const q = await funded(s)
    s.world.now = LOCKTIME + 1
    const first = await s.intents.refundSend(q.id)
    const second = await s.intents.refundSend(q.id)
    expect(second).toEqual(first)
    expect(s.venue.pushes).toHaveLength(1)

    const settled = setup()
    const q2 = await funded(settled)
    settled.world.solver = 'settled'
    await settled.intents.reconcile()
    await expect(settled.intents.refundSend(q2.id)).rejects.toMatchObject({ code: 'ALREADY_SETTLED' })

    const quoted = setup()
    const q3 = await quoted.intents.quoteSend(INV_5000)
    await expect(quoted.intents.refundSend(q3.id)).rejects.toMatchObject({ code: 'NOTHING_TO_REFUND' })
    expect(quoted.venue.refundSend).not.toHaveBeenCalled()
    await expect(quoted.intents.refundSend('nope')).rejects.toMatchObject({ code: 'SWAP_NOT_FOUND' })
  })

  it('(g) underpaid lockup: the solver never pays, and the refund returns what is there', async () => {
    const s = setup({ lockedSats: 4000 })
    s.fund.mockImplementationOnce(async () => 'short-txid') // host sent less than fundAmountSats
    const q = await funded(s)
    await s.intents.reconcile()
    expect((await s.intents.getSwap(q.id))?.status).toBe('pending')
    s.world.now = LOCKTIME + 1
    expect(await s.intents.refundSend(q.id)).toMatchObject({ status: 'refunded', fundingTxid: 'short-txid' })
  })

  it('(g) an empty lockup after the window ends cancelled (nothing to return)', async () => {
    const s = setup({ lockedSats: 0 })
    const q = await funded(s)
    s.world.now = LOCKTIME + 1
    expect((await s.intents.refundSend(q.id)).status).toBe('cancelled')
  })

  it('(h) the solver settles while a refund is requested: settled wins, no refund pushed', async () => {
    const s = setup()
    const q = await funded(s)
    s.world.now = LOCKTIME + 1
    s.world.solver = 'settled' // the claim landed just before our push
    expect(await s.intents.refundSend(q.id)).toMatchObject({ status: 'settled', resolvedTxid: 'solver-claim' })
    expect(s.venue.pushes).toHaveLength(0)
    expect(transactionStatusOf('settled')).toBe('confirmed')
  })
})

describe('re-quoting and quote_conflict', () => {
  it('a second quote of the same invoice returns the stored quote instead of earning quote_conflict', async () => {
    const s = setup()
    const a = await s.intents.quoteSend(INV_5000)
    const b = await s.intents.quoteSend(INV_5000)
    expect(b.id).toBe(a.id)
    expect(s.venue.prepareLightningSend).toHaveBeenCalledTimes(1)
  })

  it('an expired or used quote is refused locally with a clear message', async () => {
    const s = setup()
    const q = await s.intents.quoteSend(INV_5000)
    s.world.now += 61
    expect(await s.intents.quoteSend(INV_5000).catch((e) => e)).toMatchObject({ code: 'INTENTS_REFUSED', reason: 'quote_conflict', kind: 'already_quoted' })
    s.world.now -= 61
    await s.intents.executeSend(q.id)
    await expect(s.intents.quoteSend(INV_5000)).rejects.toMatchObject({ code: 'INVOICE_IN_PROGRESS' })
    s.world.solver = 'settled'
    await s.intents.reconcile()
    await expect(s.intents.quoteSend(INV_5000)).rejects.toMatchObject({ code: 'INVOICE_ALREADY_PAID' })
    expect(s.fund).toHaveBeenCalledTimes(1) // never paid twice
  })

  it('paying our own receive invoice is refused as SELF_PAYMENT', async () => {
    const s = setup()
    const r = await s.intents.createReceive(1000, { amountSide: 'from' })
    await expect(s.intents.quoteSend(r.invoice)).rejects.toMatchObject({ code: 'SELF_PAYMENT' })
  })

  it("the solver's quote_conflict is typed with an actionable message", async () => {
    const s = setup()
    s.venue.prepareLightningSend.mockRejectedValueOnce(
      Object.assign(new Error('solver refused: quote_conflict'), { reason: 'quote_conflict', rfqId: 'x' }),
    )
    const err = await s.intents.quoteSend(INV_5000).catch((e) => e)
    expect(err).toMatchObject({ code: 'INTENTS_REFUSED', reason: 'quote_conflict', kind: 'already_quoted' })
    expect(err.message).toMatch(/new invoice/)
  })
})

describe('LN -> Ark receive left unpaid', () => {
  it('(i) ends cancelled with nothing to refund; the hold invoice is the solver\'s to cancel', async () => {
    const s = setup()
    const r = await s.intents.createReceive(1000, { amountSide: 'from' })
    s.world.now += 3600 // invoice expired, window still open
    await s.intents.reconcile()
    expect((await s.intents.getSwap(r.id))?.status).toBe('pending')
    s.world.now = T0 + 2.5 * 3600 + REFUND_MTP_LAG_SECONDS
    const report = await s.intents.reconcile()
    expect(report?.cancelled).toContain(r.id)
    const swap = (await s.intents.findByPaymentHash(r.paymentHash))!
    expect(swap).toMatchObject({ status: 'cancelled', direction: 'receive' })
    expect(transactionStatusOf(swap.status)).toBe('cancelled')
    await expect(s.intents.refundSend(r.id)).rejects.toMatchObject({ code: 'NOT_REFUNDABLE' })
    expect(s.fund).not.toHaveBeenCalled()
  })
})
