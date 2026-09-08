import { describe, it, expect } from 'vitest'
import { RlnWdkAdapter } from '../src/adapters/wdk/RlnWdkAdapter'

const BOLT11 =
  'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql'

function connectedRln() {
  const calls: Record<string, any[]> = {}
  const record = (name: string) => async (body: any) => {
    ;(calls[name] ??= []).push(body)
    if (name === 'createLNInvoice') return { invoice: BOLT11 }
    if (name === 'createRgbInvoice') return { invoice: 'rgb:...', recipient_id: 'rcpt' }
    if (name === 'sendPayment') return { payment_hash: 'ph', status: 'Succeeded' }
    return {}
  }
  const adapter = new RlnWdkAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account: {
      getAddress: async () => 'bcrt1qbtconchain',
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

  it('sendPayment never re-amounts an amount-bearing invoice', async () => {
    const { adapter, calls } = connectedRln()
    // lnbc10u… encodes 10 µBTC = 1000 sats; a stale caller-supplied amount
    // must not override it (the node pays the invoice amount).
    await adapter.sendPayment({ invoice: 'lnbc10u1pabcdef...', amount: 1500 })
    const body = calls.sendPayment[0]
    expect(body.amt_msat).toBeUndefined()
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

  it('getReceiveAddress returns a BTC on-chain address for "BTC" (not an RGB invoice)', async () => {
    const { adapter, calls } = connectedRln()
    const btc = await adapter.getReceiveAddress('BTC')
    expect(btc).toEqual({ address: 'bcrt1qbtconchain', format: 'BTC_ADDRESS' })
    const none = await adapter.getReceiveAddress()
    expect(none.format).toBe('BTC_ADDRESS')
    expect(calls.createRgbInvoice).toBeUndefined()
  })
})
