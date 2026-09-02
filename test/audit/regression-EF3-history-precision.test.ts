/*
 * Regression test for audit finding E-F3 (REPORT.md §2.2, REPORT-2.md §4.2).
 *
 * The three RGB history converters hardcoded precision 8 for ASSET amounts, so
 * a 500-unit precision-0 receive displayed as "0.00000500" — understated by
 * 10^8. History is what a merchant checks before treating an invoice as paid.
 *
 * Commit 41bc6bf fixed the *balance* side (E-F2) by resolving precision per
 * asset through `getAssetMetadata` and explicitly deferred this half. Three
 * distinct assets can appear in one history call, which is why the resolution
 * is per row rather than per call:
 *   - transfers          → the requested asset (`filter.asset`)
 *   - lightning payments → each payment's own `asset_id`, and SATS (precision 8)
 *                          when the row fell back to `amt_msat / 1000`
 *   - swaps              → each swap's `from_asset`, which on a to-leg match is
 *                          the COUNTER asset, not the requested one
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  convertTransferToTransaction,
  convertSwapToTransaction,
  convertPaymentToTransaction,
} from '../../src/lib/rgb-converters'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'

afterEach(() => vi.restoreAllMocks())

describe('E-F3: the three RGB history converters render at the asset\'s own precision', () => {
  it('convertTransferToTransaction', () => {
    expect(convertTransferToTransaction({ amount: 500 }, 0).amountDisplay).toBe('500')
    expect(convertTransferToTransaction({ amount: 500 }, 2).amountDisplay).toBe('5.00')
    // Default is unchanged: 8, the BTC convention.
    expect(convertTransferToTransaction({ amount: 500 }).amountDisplay).toBe('0.00000500')
  })

  it('convertSwapToTransaction renders qty_from at the FROM asset\'s precision', () => {
    expect(convertSwapToTransaction({ qty_from: 500 }, 'taker', 0).amountDisplay).toBe('500')
    expect(convertSwapToTransaction({ qty_from: 500 }, 'taker').amountDisplay).toBe('0.00000500')
  })

  it('convertPaymentToTransaction applies precision only to the asset_amount branch', () => {
    expect(convertPaymentToTransaction({ asset_amount: 500 }, 0).amountDisplay).toBe('500')
    // The amt_msat fallback yields SATS, which are BTC and stay at 8 no matter
    // what precision the caller passes — the two branches share one field.
    expect(convertPaymentToTransaction({ amt_msat: 1_500_000 }, 0).amountDisplay).toBe(
      '0.00001500',
    )
    expect(convertPaymentToTransaction({ amt_msat: 1_500_000 }).amountDisplay).toBe('0.00001500')
  })

  it('the fee field is sats and is NOT reinterpreted at the asset precision', () => {
    // `fee` on a transfer is the on-chain miner fee — denominated in sats
    // regardless of which asset moved.
    expect(convertTransferToTransaction({ amount: 500, fee: 250 }, 0).feeDisplay).toBe(
      '0.00000250',
    )
  })
})

describe('E-F3: RgbAdapter.listTransactions resolves precision per asset', () => {
  const PRECISIONS: Record<string, number> = {
    'rgb:prec0': 0,
    'rgb:prec2': 2,
  }

  function adapterWith(client: unknown): RgbAdapter {
    const a = new RgbAdapter()
    Object.assign(a as any, { connected: true, config: { protocol: 'RGB_LN', network: 'regtest' } })
    vi.spyOn(kaleidoClientManager, 'hasNode').mockReturnValue(true)
    vi.spyOn(kaleidoClientManager, 'isInitialized').mockReturnValue(true)
    vi.spyOn(kaleidoClientManager, 'getClient').mockReturnValue(client as any)
    return a
  }

  const metadataCalls: string[] = []
  function fakeClient(over: Record<string, unknown> = {}) {
    metadataCalls.length = 0
    return {
      rln: {
        listTransfers: async () => ({ transfers: [] }),
        listPayments: async () => ({ payments: [] }),
        listSwaps: async () => ({ maker: [], taker: [] }),
        getAssetMetadata: async ({ asset_id }: { asset_id: string }) => {
          metadataCalls.push(asset_id)
          if (!(asset_id in PRECISIONS)) throw new Error(`unknown asset ${asset_id}`)
          return { precision: PRECISIONS[asset_id] }
        },
        ...over,
      },
    }
  }

  it('renders an on-chain transfer of a precision-0 asset at its real precision', async () => {
    const a = adapterWith(
      fakeClient({
        listTransfers: async () => ({
          transfers: [{ txid: 't1', kind: 'ReceiveAsset', status: 'Settled', amount: 500, created_at: 1 }],
        }),
      }),
    )
    const [tx] = await a.listTransactions({ asset: 'rgb:prec0' })
    expect(tx.amountDisplay, 'a 500-unit precision-0 receive is 500 units').toBe('500')
  })

  it('renders a swap at the FROM asset\'s precision, not the requested asset\'s', async () => {
    // Requested rgb:prec2, but the swap SOLD rgb:prec0 to buy it — `qty_from` is
    // in rgb:prec0 units. Resolving only `filter.asset` would render it at 2.
    const a = adapterWith(
      fakeClient({
        listSwaps: async () => ({
          maker: [
            {
              payment_hash: 's1',
              status: 'Completed',
              requested_at: 1,
              qty_from: 500,
              from_asset: 'rgb:prec0',
              to_asset: 'rgb:prec2',
            },
          ],
          taker: [],
        }),
      }),
    )
    const [tx] = await a.listTransactions({ asset: 'rgb:prec2' })
    expect(tx.amountDisplay).toBe('500')
    expect(metadataCalls).toContain('rgb:prec0')
  })

  it('renders each payment at its own asset\'s precision', async () => {
    const a = adapterWith(
      fakeClient({
        listPayments: async () => ({
          payments: [
            { payment_hash: 'p1', inbound: true, status: 'Succeeded', created_at: 1, asset_amount: 500, asset_id: 'rgb:prec0' },
          ],
        }),
      }),
    )
    const [tx] = await a.listTransactions({ asset: 'rgb:prec0' })
    expect(tx.amountDisplay).toBe('500')
  })

  it('costs one metadata lookup per DISTINCT asset, not one per row', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      txid: `t${i}`,
      kind: 'ReceiveAsset',
      status: 'Settled',
      amount: 500,
      created_at: 1,
    }))
    const a = adapterWith(fakeClient({ listTransfers: async () => ({ transfers: rows }) }))
    const txs = await a.listTransactions({ asset: 'rgb:prec0' })
    expect(txs).toHaveLength(5)
    expect(metadataCalls).toEqual(['rgb:prec0'])
  })

  it('BTC costs no lookup at all and stays at 8', async () => {
    const a = adapterWith(
      fakeClient({
        listPayments: async () => ({
          payments: [{ payment_hash: 'p1', inbound: true, status: 'Succeeded', created_at: 1, amt_msat: 1_500_000 }],
        }),
      }),
    )
    const [tx] = await a.listTransactions({ asset: 'BTC' })
    expect(tx.amountDisplay).toBe('0.00001500')
    expect(metadataCalls, 'BTC precision is 8 by definition').toEqual([])
  })

  it('fails the call when precision cannot be resolved, rather than fabricating 8', async () => {
    // Same policy as the three history rails (e92aa0b): a history rendered at a
    // fabricated precision is wrong in the same silent way as one missing a rail,
    // and UnifiedTransaction has no `partial` flag to degrade to.
    const a = adapterWith(
      fakeClient({
        listTransfers: async () => ({
          transfers: [{ txid: 't1', kind: 'ReceiveAsset', status: 'Settled', amount: 500, created_at: 1 }],
        }),
      }),
    )
    await expect(a.listTransactions({ asset: 'rgb:unknown' })).rejects.toThrow()
  })

  it('a metadata response with no precision field still defaults to 8', async () => {
    // Matches getAssetBalance (41bc6bf): a SUCCESSFUL response that omits the
    // field falls back; only a thrown lookup fails the call.
    const a = adapterWith(
      fakeClient({
        listTransfers: async () => ({
          transfers: [{ txid: 't1', kind: 'ReceiveAsset', status: 'Settled', amount: 500, created_at: 1 }],
        }),
        getAssetMetadata: async () => ({}),
      }),
    )
    const [tx] = await a.listTransactions({ asset: 'rgb:whatever' })
    expect(tx.amountDisplay).toBe('0.00000500')
  })
})
