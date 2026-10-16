import { describe, it, expect, vi, afterEach } from 'vitest'
import { SparkAdapter } from '../src/adapters/SparkAdapter'
import { SparkWdkAdapter } from '../src/adapters/wdk/SparkWdkAdapter'
import { bolt11Fixture, TEST_PAYMENT_HASH } from './fixtures/bolt11'

/**
 * Spark `decodeInvoice` must not build a summary from the BOLT11 prefix alone: a
 * corrupted, wrong-network or expired invoice is rejected, never shown as payable.
 */
const NOW_MS = 1_700_000_100_000

function nativeAdapter(network: 'mainnet' | 'regtest' | 'signet') {
  const adapter = new SparkAdapter()
  ;(adapter as unknown as { config: { protocol: string; network: string } }).config = { protocol: 'SPARK', network }
  return adapter
}

function wdkAdapter(network: 'mainnet' | 'regtest' | 'signet') {
  const adapter = new SparkWdkAdapter()
  ;(adapter as unknown as { network: string }).network = network
  return adapter
}

const ADAPTERS = [
  ['SparkAdapter', nativeAdapter],
  ['SparkWdkAdapter', wdkAdapter],
] as const

afterEach(() => vi.useRealTimers())

describe.each(ADAPTERS)('%s.decodeInvoice BOLT11 validation', (_name, make) => {
  it('decodes a valid invoice with its payment hash, amount and expiry', async () => {
    vi.useFakeTimers({ now: NOW_MS })
    const invoice = bolt11Fixture({ hrp: 'lnbcrt2500u' })
    const d = await make('regtest').decodeInvoice(invoice)
    expect(d.paymentHash).toBe(TEST_PAYMENT_HASH)
    expect(d.amount).toBe(250_000)
    expect(d.amountMsat).toBe(250_000_000)
    expect(d.expiresAt).toBe((1_700_000_000 + 3600) * 1000)
    expect(d.destination).toBe(invoice)
  })

  it('decodes an amountless invoice without inventing an amount', async () => {
    vi.useFakeTimers({ now: NOW_MS })
    const d = await make('mainnet').decodeInvoice(bolt11Fixture({ hrp: 'lnbc' }))
    expect(d.amount).toBeUndefined()
    expect(d.paymentHash).toBe(TEST_PAYMENT_HASH)
  })

  it('accepts signet invoices on a signet wallet', async () => {
    vi.useFakeTimers({ now: NOW_MS })
    await expect(make('signet').decodeInvoice(bolt11Fixture({ hrp: 'lntbs10u' }))).resolves.toMatchObject({ amount: 1000 })
  })

  it('rejects a garbage invoice whose prefix encodes 100 sats', async () => {
    await expect(make('mainnet').decodeInvoice('lnbc1u1pgarbage')).rejects.toMatchObject({ code: 'INVALID_INVOICE' })
  })

  it('rejects an invoice with one character changed', async () => {
    vi.useFakeTimers({ now: NOW_MS })
    const valid = bolt11Fixture({ hrp: 'lnbc10u' })
    const i = 40
    const corrupted = valid.slice(0, i) + (valid[i] === 'q' ? 'p' : 'q') + valid.slice(i + 1)
    await expect(make('mainnet').decodeInvoice(corrupted)).rejects.toMatchObject({ code: 'INVALID_INVOICE' })
    await expect(make('mainnet').decodeInvoice(`${valid}q`)).rejects.toMatchObject({ code: 'INVALID_INVOICE' })
  })

  it('rejects an invoice for another network', async () => {
    vi.useFakeTimers({ now: NOW_MS })
    await expect(make('mainnet').decodeInvoice(bolt11Fixture({ hrp: 'lnbcrt10u' }))).rejects.toMatchObject({
      code: 'NETWORK_MISMATCH',
    })
    await expect(make('regtest').decodeInvoice(bolt11Fixture({ hrp: 'lnbc10u' }))).rejects.toMatchObject({
      code: 'NETWORK_MISMATCH',
    })
  })

  it('rejects an expired invoice', async () => {
    vi.useFakeTimers({ now: (1_700_000_000 + 3600) * 1000 })
    await expect(make('mainnet').decodeInvoice(bolt11Fixture({ hrp: 'lnbc10u' }))).rejects.toMatchObject({
      code: 'INVOICE_EXPIRED',
    })
  })
})
