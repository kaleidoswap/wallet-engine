import { afterEach, describe, expect, it, vi } from 'vitest'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { RlnWdkAdapter } from '../../src/adapters/wdk/RlnWdkAdapter'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'
import { convertPaymentToTransaction } from '../../src/lib/rgb-converters'
import { decodeBolt11 } from '../../src/lib/bolt11'

afterEach(() => vi.restoreAllMocks())

describe('E-F6: one integer-sat rendering for millisatoshis', () => {
  it('native RGB decode rounds 1500 msat to 2 sats and preserves msat', async () => {
    vi.spyOn(kaleidoClientManager, 'hasNode').mockReturnValue(true)
    vi.spyOn(kaleidoClientManager, 'isInitialized').mockReturnValue(true)
    vi.spyOn(kaleidoClientManager, 'getClient').mockReturnValue({
      rln: { decodeLNInvoice: async () => ({ amt_msat: 1500 }) },
    } as never)
    const adapter = new RgbAdapter()
    Object.assign(adapter as never, { connected: true })
    const decoded = await adapter.decodeInvoice('lnbc15n1example')
    expect(decoded).toMatchObject({ amount: 2, amountMsat: 1500 })
  })

  it('WDK RGB decode rounds 1500 msat to 2 sats and preserves msat', async () => {
    const adapter = new RlnWdkAdapter()
    Object.assign(adapter as never, {
      connected: true,
      account: { decodeLNInvoice: async () => ({ amt_msat: 1500 }) },
    })
    const decoded = await adapter.decodeInvoice('lnbc15n1example')
    expect(decoded).toMatchObject({ amount: 2, amountMsat: 1500 })
  })

  it('RGB payment history rounds 1500 msat to 2 sats', () => {
    expect(convertPaymentToTransaction({ amt_msat: 1500 }).amount).toBe(2)
  })

  it('the BOLT11 compatibility summary uses the same rule', () => {
    expect(decodeBolt11('lnbc15n1example').amountSat).toBe(2)
  })
})
