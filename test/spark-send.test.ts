import { describe, it, expect } from 'vitest'
import { SparkWdkAdapter } from '../src/adapters/wdk/SparkWdkAdapter'

/** Connected adapter capturing the options passed to payLightningInvoice(). */
function adapterPayingLn() {
  const calls: any[] = []
  const adapter = new SparkWdkAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account: {
      payLightningInvoice: async (opts: any) => {
        calls.push(opts)
        return {
          id: 'SparkLightningSendRequest:req-1',
          createdAt: '2026-08-30T12:00:00.000Z',
          updatedAt: '2026-08-30T12:00:01.000Z',
          network: 'BITCOIN_MAINNET',
          encodedInvoice: opts.invoice,
          fee: { originalValue: 2, originalUnit: 'SATOSHI' },
          idempotencyKey: 'idem-1',
          status: 'LIGHTNING_PAYMENT_SUCCEEDED',
          typename: 'LightningSendRequest',
          paymentPreimage: 'ab'.repeat(32),
        }
      },
    },
  })
  return { adapter, calls }
}

const LN_INVOICE = 'lnbc1exampleinvoice'

describe('SparkWdkAdapter.sendPayment Lightning (amountless invoice parity)', () => {
  it('passes amountSatsToSend for an amountless invoice (explicit amount given)', async () => {
    const { adapter, calls } = adapterPayingLn()
    await adapter.sendPayment({ invoice: LN_INVOICE, amount: 7_500 } as any)
    expect(calls[0].invoice).toBe(LN_INVOICE)
    expect(calls[0].amountSatsToSend).toBe(7_500)
  })

  it('omits amountSatsToSend for an amount-carrying invoice (no explicit amount)', async () => {
    const { adapter, calls } = adapterPayingLn()
    await adapter.sendPayment({ invoice: LN_INVOICE } as any)
    expect('amountSatsToSend' in calls[0]).toBe(false)
  })

  it('omits amountSatsToSend when the explicit amount is zero', async () => {
    const { adapter, calls } = adapterPayingLn()
    await adapter.sendPayment({ invoice: LN_INVOICE, amount: 0 } as any)
    expect('amountSatsToSend' in calls[0]).toBe(false)
  })

  it('maps the declared LightningSendRequest fields and invoice amount', async () => {
    const { adapter } = adapterPayingLn()
    const result = await adapter.sendPayment({ invoice: 'lnbc1m1pexample' } as any)
    expect(result).toEqual({
      paymentHash: 'SparkLightningSendRequest:req-1',
      preimage: 'ab'.repeat(32),
      amount: 100_000,
      fee: 2,
      status: 'confirmed',
      timestamp: Date.parse('2026-08-30T12:00:00.000Z'),
    })
  })
})
