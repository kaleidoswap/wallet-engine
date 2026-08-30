/*
 * OPEN FINDING — reproduction, not yet fixed.
 *
 * `describe.skip` so the branch stays green: these assert the behaviour the
 * code SHOULD have. Remove the `.skip` when the finding is fixed and they
 * become its regression test. See REPORT.md for the finding this belongs to.
 */
import { describe, it, expect } from 'vitest'
import { RlnWdkAdapter } from '../../src/adapters/wdk/RlnWdkAdapter'

/**
 * AUDIT C-F2 — decodeInvoice reports EXPIRED invoices as payable.
 *
 * The node's DecodeLNInvoiceResponse carries BOTH `timestamp` (invoice creation,
 * unix seconds) and `expiry_sec` (a DURATION relative to `timestamp`).
 * src/adapters/wdk/RlnWdkAdapter.ts:312 computes
 *     expiresAt = Date.now() + expiry_sec * 1000
 * ignoring `timestamp` — so an invoice created 2h ago with a 1h expiry decodes
 * to an expiresAt ~1h in the FUTURE. (Same pattern at src/adapters/RgbAdapter.ts:484.)
 */
function connectedRln(account: any) {
  const adapter = new RlnWdkAdapter()
  Object.assign(adapter as any, { connected: true, account })
  return adapter
}

describe.skip('AUDIT C-F2: decodeInvoice expiry', () => {
  it('an invoice created 2h ago with expiry_sec=3600 must decode as already expired', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const adapter = connectedRln({
      decodeLNInvoice: async () => ({
        amt_msat: 5_000_000,
        expiry_sec: 3600, // 1h duration...
        timestamp: nowSec - 7200, // ...from a creation time 2h ago => expired 1h ago
        payment_hash: 'ph',
        payment_secret: 'ps',
        payee_pubkey: 'pk',
        network: 'Regtest',
      }),
    })
    const d = await adapter.decodeInvoice('lnbc50u1pabcdef')
    // Correct value: (timestamp + expiry_sec) * 1000 = ~1h in the PAST.
    expect(d.expiresAt).toBeLessThanOrEqual(Date.now())
  })
})
