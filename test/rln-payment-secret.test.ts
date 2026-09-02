import { describe, expect, it } from 'vitest'

import { RlnWdkAdapter } from '../src/adapters/wdk/RlnWdkAdapter'

describe('RlnWdkAdapter payment-secret handling', () => {
  it('does not expose the BOLT11 payment secret as a settlement preimage', async () => {
    const adapter = new RlnWdkAdapter()
    Object.assign(adapter as any, {
      connected: true,
      account: {
        _rln: {
          sendPayment: async () => ({
            payment_hash: 'payment-hash',
            payment_secret: '11'.repeat(32),
            status: 'Succeeded',
          }),
        },
      },
    })

    const result = await adapter.sendPayment({ invoice: 'lnbc10u1ptest' })

    expect(result.paymentHash).toBe('payment-hash')
    expect(result.preimage).toBeUndefined()
  })
})
