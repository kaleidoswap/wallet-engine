/*
 * FIXED — this is now the finding's regression test (run 2, REPORT-2.md).
 *
 * It was landed by run 1 as a committed `describe.skip`ped reproduction of a
 * confirmed-but-unfixed finding. Run 2 verified the claim against the contract,
 * fixed the code, and removed the `.skip` — so this file now fails if the finding
 * regresses. The commit that removed the `.skip` records the failing output at its
 * parent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'

const state = { client: null as any }
vi.mock('../../src/lib/kaleido-client-manager', () => ({
  kaleidoClientManager: {
    hasNode: () => true,
    isInitialized: () => true,
    getClient: () => state.client,
    reset: () => {},
  },
}))

/**
 * Task G finding — RgbAdapter.listTransactions silently drops Lightning
 * payments and swap history when those node endpoints fail.
 *
 * src/adapters/RgbAdapter.ts:344-355 fetches transfers + payments + swaps in
 * Promise.all, but two of the three legs have their own catch:
 *     client.rln.listPayments().catch(() => ({ payments: [] }))      // L348
 *     client.rln.listSwaps().catch(() => ({ maker: [], taker: [] })) // L351
 * Only the listTransfers leg failing throws (via the outer catch at 401-403).
 *
 * Caller belief after an NWC relay timeout / maker API 500: "this asset has
 * zero Lightning payments and zero swaps" — the activity view presents a
 * COMPLETE-looking history that is missing whole rails. A user reconciling
 * their balance against history sees sats they cannot account for.
 */

const TRANSFER = {
  txid: 'b'.repeat(64),
  created_at: 1_756_000_000,
  kind: 'Issuance',
  status: 'Settled',
  amount: 1000,
}
const PAYMENT = {
  payment_hash: 'c'.repeat(64),
  created_at: 1_756_000_100,
  inbound: false,
  status: 'Succeeded',
  amt_msat: 500_000,
}

function adapter() {
  const a = new RgbAdapter()
  Object.assign(a as any, { connected: true, config: {} })
  return a
}

beforeEach(() => {
  state.client = {
    rln: {
      listTransfers: async () => ({ transfers: [TRANSFER] }),
      listPayments: async () => ({ payments: [PAYMENT] }),
      listSwaps: async () => ({ maker: [], taker: [] }),
    },
  }
})

describe('G: RgbAdapter.listTransactions must not present partial history as complete', () => {
  it('baseline: all three rails merged when healthy', async () => {
    const txs = await adapter().listTransactions({ asset: 'BTC' })
    expect(txs.length).toBe(2) // transfer + payment
  })

  it('a failing listPayments endpoint must surface an error, not a history missing all LN payments', async () => {
    state.client.rln.listPayments = async () => { throw new Error('NWC relay timeout') }
    await expect(adapter().listTransactions({ asset: 'BTC' })).rejects.toThrow()
  })

  it('a failing listSwaps endpoint must surface an error, not a history missing all swaps', async () => {
    state.client.rln.listSwaps = async () => { throw new Error('maker API 500') }
    await expect(adapter().listTransactions({ asset: 'BTC' })).rejects.toThrow()
  })
})
