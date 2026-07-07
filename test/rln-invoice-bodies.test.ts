import { describe, it, expect } from 'vitest'
import { RlnWdkAdapter } from '../src/adapters/wdk/RlnWdkAdapter'

function connectedRln() {
  const calls: Record<string, any[]> = {}
  const record = (name: string) => async (body: any) => {
    ;(calls[name] ??= []).push(body)
    if (name === 'createLNInvoice') return { invoice: 'lnbc...' }
    if (name === 'createRgbInvoice') return { invoice: 'rgb:...', recipient_id: 'rcpt' }
    if (name === 'sendPayment') return { payment_hash: 'ph', status: 'Succeeded' }
    return {}
  }
  const adapter = new RlnWdkAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account: {
      _rln: {
        createLNInvoice: record('createLNInvoice'),
        createRgbInvoice: record('createRgbInvoice'),
        sendPayment: record('sendPayment'),
        getInvoiceStatus: record('getInvoiceStatus'),
      },
    },
  })
  return { adapter, calls }
}

describe('RlnWdkAdapter invoice/payment bodies', () => {
  it('createInvoice(asset) builds an RGB-over-Lightning body with asset_id + asset_amount', async () => {
    const { adapter, calls } = connectedRln()
    await adapter.createInvoice({ asset: 'rgb:usdt', assetAmount: 42, expirySeconds: 900 })
    expect(calls.createLNInvoice).toHaveLength(1)
    const body = calls.createLNInvoice[0]
    expect(body.asset_id).toBe('rgb:usdt')
    expect(body.asset_amount).toBe(42)
    expect(body.amt_msat).toBe(3_000_000)
    expect(body.expiry_sec).toBe(900)
  })

  it('createInvoice(asset, layer RGB_L1) builds an on-chain RGB body (witness + Fungible assignment)', async () => {
    const { adapter, calls } = connectedRln()
    await adapter.createInvoice({ asset: 'rgb:usdt', assetAmount: 5, layer: 'RGB_L1' })
    expect(calls.createRgbInvoice).toHaveLength(1)
    const body = calls.createRgbInvoice[0]
    expect(body.asset_id).toBe('rgb:usdt')
    expect(body.witness).toBe(true)
    expect(body.min_confirmations).toBe(1)
    expect(typeof body.expiration_timestamp).toBe('number')
    expect(body.assignment).toEqual({ type: 'Fungible', value: 5 })
    expect(body.duration_seconds).toBeUndefined()
  })

  it('createInvoice(BTC) builds a plain LN body (no asset fields)', async () => {
    const { adapter, calls } = connectedRln()
    await adapter.createInvoice({ amount: 1000 })
    const body = calls.createLNInvoice[0]
    expect(body.amt_msat).toBe(1_000_000)
    expect(body.asset_id).toBeUndefined()
  })

  it('createRgbInvoice honors a pre-built Fungible assignment', async () => {
    const { adapter, calls } = connectedRln()
    await adapter.createRgbInvoice({
      assetId: 'rgb:usdt',
      witness: false,
      assignment: { type: 'Fungible', value: 9 },
    })
    const body = calls.createRgbInvoice[0]
    expect(body.witness).toBe(false)
    expect(body.assignment).toEqual({ type: 'Fungible', value: 9 })
  })

  it('sendPayment forwards amt_msat for a zero-amount BTC invoice', async () => {
    const { adapter, calls } = connectedRln()
    await adapter.sendPayment({ invoice: ' lnbc1... ', amount: 1500 })
    const body = calls.sendPayment[0]
    expect(body.invoice).toBe('lnbc1...')
    expect(body.amt_msat).toBe(1_500_000)
  })

  it('sendPayment forwards asset_id + asset_amount for an open-amount RGB invoice', async () => {
    const { adapter, calls } = connectedRln()
    await adapter.sendPayment({ invoice: 'lnbc1...', asset_id: 'rgb:usdt', asset_amount: 7 } as any)
    const body = calls.sendPayment[0]
    expect(body.asset_id).toBe('rgb:usdt')
    expect(body.asset_amount).toBe(7)
    expect(body.amt_msat).toBeUndefined()
  })

  it('getInvoiceStatus queries the node with the bolt11 invoice, not a payment hash', async () => {
    const { adapter, calls } = connectedRln()
    await adapter.getInvoiceStatus({ invoice: 'lnbc1abc...' })
    expect(calls.getInvoiceStatus[0]).toEqual({ invoice: 'lnbc1abc...' })
  })
})
