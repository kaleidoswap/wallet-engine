import { afterEach, describe, expect, it, vi } from 'vitest'
import { RgbAdapter } from '../src/adapters/RgbAdapter'
import { kaleidoClientManager } from '../src/lib/kaleido-client-manager'

afterEach(() => vi.restoreAllMocks())

describe('RgbAdapter.getPaymentStatus SDK result shape', () => {
  it('reads amt_msat and converts the provider timestamp from seconds', async () => {
    vi.spyOn(kaleidoClientManager, 'isInitialized').mockReturnValue(true)
    vi.spyOn(kaleidoClientManager, 'hasNode').mockReturnValue(true)
    vi.spyOn(kaleidoClientManager, 'getClient').mockReturnValue({
      rln: {
        getPayment: async () => ({
          payment: {
            payment_hash: 'payment-1',
            inbound: false,
            status: 'Succeeded',
            amt_msat: 1500,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_001,
            payee_pubkey: '02'.repeat(33),
          },
        }),
      },
    } as any)

    const adapter = new RgbAdapter()
    Object.assign(adapter as any, { connected: true })
    await expect(adapter.getPaymentStatus('payment-1')).resolves.toEqual({
      paymentHash: 'payment-1',
      status: 'confirmed',
      amount: 2,
      fee: undefined,
      timestamp: 1_700_000_000_000,
    })
  })
})
