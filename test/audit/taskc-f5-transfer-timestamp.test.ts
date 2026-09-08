/*
 * FIXED — this is now the finding's regression test (run 2, REPORT-2.md).
 *
 * It was landed by run 1 as a committed `describe.skip`ped reproduction of a
 * confirmed-but-unfixed finding. Run 2 verified the claim against the contract,
 * fixed the code, and removed the `.skip` — so this file now fails if the finding
 * regresses. The commit that removed the `.skip` records the failing output at its
 * parent.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { convertTransferToTransaction } from '../../src/lib/rgb-converters'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'

/**
 * AUDIT C-F5 — convertTransferToTransaction uses `created_at` (unix SECONDS,
 * per the node's Transfer schema) as a millisecond timestamp.
 *
 * src/lib/rgb-converters.ts:137 — compare the sibling converters in the same
 * file, which both multiply by 1000 (lines 166, 193-195). Downstream,
 * RgbAdapter.listTransactions sorts and applies fromTimestamp/toTimestamp
 * filters in ms, so RGB on-chain transfer history is dropped/misordered.
 */
describe('AUDIT C-F5: transfer timestamp units', () => {
  afterEach(() => vi.restoreAllMocks())

  it('created_at (seconds) must be converted to ms like the other converters', () => {
    const tx = convertTransferToTransaction({
      created_at: 1_691_160_765, // 2023-08-04, in seconds per node schema
      kind: 'receive',
      status: 'Settled',
      amount: 5,
      txid: 'abc',
    })
    expect(tx.timestamp).toBe(1_691_160_765_000)
  })

  it('RgbAdapter.listTransactions with a fromTimestamp filter must keep recent transfers', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const fakeClient = {
      rln: {
        listTransfers: async () => ({
          transfers: [
            { created_at: nowSec, kind: 'ReceiveAsset', status: 'Settled', amount: 7, txid: 't1' },
          ],
        }),
        listPayments: async () => ({ payments: [] }),
        listSwaps: async () => ({ maker: [], taker: [] }),
        // listTransactions resolves each asset's display precision (E-F3), the
        // same way getAssetBalance already did (41bc6bf). Declared on the SDK
        // client at node_modules/kaleido-sdk/dist/rln-client.d.ts:51 — this fake
        // simply predates the call. Precision is irrelevant to this test, which
        // asserts timestamp-unit handling.
        getAssetMetadata: async () => ({ precision: 8 }),
      },
    }
    vi.spyOn(kaleidoClientManager, 'isInitialized').mockReturnValue(true)
    vi.spyOn(kaleidoClientManager, 'hasNode').mockReturnValue(true)
    vi.spyOn(kaleidoClientManager, 'getClient').mockReturnValue(fakeClient as any)

    const adapter = new RgbAdapter()
    Object.assign(adapter as any, { connected: true, config: { protocol: 'RGB_LN', network: 'regtest' } })

    const txs = await adapter.listTransactions({
      asset: 'rgb:asset',
      fromTimestamp: Date.now() - 60_000, // "last minute" — the transfer is from right now
    })
    expect(txs.length).toBe(1)
  })
})
