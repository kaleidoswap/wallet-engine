/*
 * FIXED — this is now the finding's regression test (run 2, REPORT-2.md).
 *
 * It was landed by run 1 as a committed `describe.skip`ped reproduction of a
 * confirmed-but-unfixed finding. Run 2 verified the claim against the contract,
 * fixed the code, and removed the `.skip` — so this file now fails if the finding
 * regresses. The commit that removed the `.skip` records the failing output at its
 * parent.
 */
import { describe, it, expect } from 'vitest'
import { RlnWdkAdapter } from '../../src/adapters/wdk/RlnWdkAdapter'

/**
 * AUDIT C-F7 — RlnWdkAdapter.sendPayment reports a fabricated amount/fee.
 *
 * src/adapters/wdk/RlnWdkAdapter.ts:337-343 returns
 *   amount: Number(request.amount ?? 0), fee: 0
 * The node's SendPaymentResponse carries only { payment_id, payment_hash?,
 * payment_secret?, status } (kaleido-sdk node-types) — no amount/fee fields —
 * so for an amount-bearing invoice (where request.amount is correctly ignored
 * for the payment itself) the result records amount=0 and fee=0 even though
 * the invoice's full amount plus a routing fee left the wallet.
 */
function connectedRln() {
  const adapter = new RlnWdkAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account: {
      _rln: {
        sendPayment: async () => ({
          payment_id: 'pid',
          payment_hash: 'ph',
          payment_secret: 'preimage',
          status: 'Succeeded',
        }),
      },
    },
  })
  return adapter
}

describe('AUDIT C-F7: sendPayment PaymentResult fidelity', () => {
  it('paying a 1000-sat amount-bearing invoice must not record amount=0', async () => {
    const adapter = connectedRln()
    // lnbc10u1... encodes 10 µBTC = 1000 sats (HRP amount is the invoice amount).
    const r = await adapter.sendPayment({ invoice: 'lnbc10u1pabcdef' } as any)
    expect(r.status).toBe('confirmed')
    expect(r.amount).toBe(1000)
  })
})
