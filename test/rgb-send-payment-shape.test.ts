import { afterEach, describe, expect, it, vi } from 'vitest'

import { RgbAdapter } from '../src/adapters/RgbAdapter'
import { kaleidoClientManager } from '../src/lib/kaleido-client-manager'

afterEach(() => vi.restoreAllMocks())

describe('RgbAdapter.sendPayment SDK result shape', () => {
  it('uses the invoice amount when SendPaymentResponse has no amount or fee fields', async () => {
    vi.spyOn(kaleidoClientManager, 'isInitialized').mockReturnValue(true)
    vi.spyOn(kaleidoClientManager, 'hasNode').mockReturnValue(true)
    vi.spyOn(kaleidoClientManager, 'getClient').mockReturnValue({
      rln: {
        sendPayment: async () => ({
          payment_id: 'payment-id',
          payment_hash: 'payment-hash',
          payment_secret: '11'.repeat(32),
          status: 'Succeeded',
        }),
      },
    } as any)

    const adapter = new RgbAdapter()
    Object.assign(adapter as any, { connected: true })
    const result = await adapter.sendPayment({ invoice: 'lnbc210u1ptest' })

    expect(result).toMatchObject({
      paymentHash: 'payment-hash',
      amount: 21_000,
      fee: 0,
      status: 'confirmed',
    })
    expect(result.preimage).toBeUndefined()
  })
})
