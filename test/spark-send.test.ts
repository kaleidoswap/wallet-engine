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
        return { paymentHash: 'ph', amountSats: opts.amountSatsToSend ?? 1234, feeSats: 1 }
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
})
