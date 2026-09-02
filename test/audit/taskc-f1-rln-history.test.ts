import { describe, it, expect } from 'vitest'
import { RlnWdkAdapter } from '../../src/adapters/wdk/RlnWdkAdapter'

/**
 * AUDIT C-F1 — RlnWdkAdapter.listTransactions direction/amount mislabel.
 *
 * The adapter reads `t.transaction_type === 'User'` and `t.amount < 0`
 * (src/adapters/wdk/RlnWdkAdapter.ts:372). But the node's Transaction schema
 * (kaleido-sdk node-types.d.ts) has:
 *   - TransactionType enum = RgbSend | Drain | CreateUtxos | SendBtc | Incoming
 *     (there is NO 'User' value)
 *   - fields txid / received / sent / fee / confirmation_time (NO 'amount')
 * so the predicate is always false and `received` (present, 0 for a send) always
 * wins over `sent` — every outbound tx is reported as an inbound receive of 0.
 */
function connectedRln(account: any) {
  const adapter = new RlnWdkAdapter()
  Object.assign(adapter as any, { connected: true, account })
  return adapter
}

describe('AUDIT C-F1: RlnWdkAdapter.listTransactions', () => {
  it('an outbound SendBtc / Drain must surface as type=send with the sent amount', async () => {
    const adapter = connectedRln({
      listTransactions: async () => ({
        transactions: [
          // Exact node shape per kaleido-sdk Transaction schema.
          {
            transaction_type: 'SendBtc',
            txid: 'send-tx',
            received: 0,
            sent: 100_000,
            fee: 500,
            confirmation_time: { height: 800_000, timestamp: 1_691_160_659 },
          },
          {
            transaction_type: 'Drain', // full-wallet drain — the tx a thief makes
            txid: 'drain-tx',
            received: 0,
            sent: 250_000,
            fee: 900,
            confirmation_time: { height: 800_001, timestamp: 1_691_160_660 },
          },
          {
            transaction_type: 'Incoming',
            txid: 'recv-tx',
            received: 5_000,
            sent: 0,
            fee: 0,
            confirmation_time: { height: 800_002, timestamp: 1_691_160_661 },
          },
        ],
      }),
    })
    const txs = await adapter.listTransactions()
    const send = txs.find((t) => t.id === 'send-tx')!
    const drain = txs.find((t) => t.id === 'drain-tx')!
    const recv = txs.find((t) => t.id === 'recv-tx')!
    expect(send.type).toBe('send')
    expect(send.amount).toBe(100_000)
    expect(drain.type).toBe('send')
    expect(drain.amount).toBe(250_000)
    expect(recv.type).toBe('receive')
    expect(recv.amount).toBe(5_000)
  })
})
