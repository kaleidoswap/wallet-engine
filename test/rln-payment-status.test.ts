import { describe, it, expect } from 'vitest'
import { RlnWdkAdapter } from '../src/adapters/wdk/RlnWdkAdapter'

/**
 * getPaymentStatus resolves the status of an OUTBOUND payment we sent. An RLN
 * node only exposes invoice-status for INBOUND invoices (keyed by bolt11), so
 * the status of a sent payment must be read from list_payments (keyed by
 * payment_hash) — otherwise a withdraw poll times out even after settlement.
 */
function connectedRln(account: any) {
  const adapter = new RlnWdkAdapter()
  Object.assign(adapter as any, { connected: true, account })
  return adapter
}

describe('RlnWdkAdapter.getPaymentStatus (outbound via list_payments)', () => {
  it('reads a sent payment status from list_payments, not getInvoiceStatus', async () => {
    let invoiceStatusCalled = false
    const adapter = connectedRln({
      getInvoiceStatus: async () => {
        invoiceStatusCalled = true
        return { status: 'pending' }
      },
      listPayments: async () => ({
        payments: [
          { payment_hash: 'aaa', status: 'Failed' },
          { payment_hash: 'hash123', status: 'Succeeded' },
        ],
      }),
    })
    const r = await adapter.getPaymentStatus('hash123')
    expect(r).toEqual({ paymentHash: 'hash123', status: 'confirmed', error: undefined })
    expect(invoiceStatusCalled).toBe(false)
  })

  it('supports a bare-array list_payments shape and camelCase keys', async () => {
    const adapter = connectedRln({
      listPayments: async () => [{ paymentHash: 'h2', status: 'failed', error: 'no route' }],
    })
    const r = await adapter.getPaymentStatus('h2')
    expect(r.status).toBe('failed')
    expect(r.error).toBe('no route')
  })

  it('returns pending (never throws) when the payment is unknown or the call fails', async () => {
    const unknown = connectedRln({ listPayments: async () => ({ payments: [] }) })
    expect(await unknown.getPaymentStatus('missing')).toEqual({ paymentHash: 'missing', status: 'pending' })

    const throws = connectedRln({
      listPayments: async () => {
        throw new Error('node down')
      },
    })
    expect(await throws.getPaymentStatus('x')).toEqual({ paymentHash: 'x', status: 'pending' })
  })
})
