import { describe, it, expect, vi, afterEach } from 'vitest'
import { SparkAdapter } from '../src/adapters/SparkAdapter'
import { SparkWdkAdapter } from '../src/adapters/wdk/SparkWdkAdapter'
import { decodeSparkBolt11 } from '../src/lib/spark-helpers'
import { bolt11Fixture, TEST_PAYMENT_HASH } from './fixtures/bolt11'

/**
 * Spark `decodeInvoice` must not build a summary from the BOLT11 prefix alone: a
 * corrupted, wrong-network or expired invoice is rejected, never shown as payable.
 */
const NOW_MS = 1_700_000_100_000

type Network = 'mainnet' | 'testnet' | 'regtest' | 'signet' | 'local' | 'MAINNET' | 'REGTEST' | 'SIGNET'

function nativeAdapter(network: Network) {
  const adapter = new SparkAdapter()
  ;(adapter as unknown as { config: { protocol: string; network: string } }).config = { protocol: 'SPARK', network }
  return adapter
}

function wdkAdapter(network: Network) {
  const adapter = new SparkWdkAdapter()
  Object.assign(adapter as unknown as object, { network, connected: true, account: {} })
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

  it('accepts lnsb invoices on a signet wallet, as spark-sdk reads them', async () => {
    vi.useFakeTimers({ now: NOW_MS })
    await expect(make('signet').decodeInvoice(bolt11Fixture({ hrp: 'lnsb10u' }))).resolves.toMatchObject({ amount: 1000 })
    await expect(make('SIGNET').decodeInvoice(bolt11Fixture({ hrp: 'lnsb10u' }))).resolves.toMatchObject({ amount: 1000 })
  })

  it('rejects lntb and lntbs invoices on a signet wallet: spark-sdk treats them as testnet', async () => {
    vi.useFakeTimers({ now: NOW_MS })
    for (const hrp of ['lntb10u', 'lntbs10u']) {
      await expect(make('signet').decodeInvoice(bolt11Fixture({ hrp }))).rejects.toMatchObject({ code: 'NETWORK_MISMATCH' })
    }
  })

  it('accepts lntb and lntbs invoices on a testnet wallet', async () => {
    vi.useFakeTimers({ now: NOW_MS })
    for (const hrp of ['lntb10u', 'lntbs10u']) {
      await expect(make('testnet').decodeInvoice(bolt11Fixture({ hrp }))).resolves.toMatchObject({ amount: 1000 })
    }
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

  it('accepts the spark-sdk uppercase network names', async () => {
    vi.useFakeTimers({ now: NOW_MS })
    await expect(make('MAINNET').decodeInvoice(bolt11Fixture({ hrp: 'lnbc10u' }))).resolves.toMatchObject({ amount: 1000 })
    await expect(make('MAINNET').decodeInvoice(bolt11Fixture({ hrp: 'lnbcrt10u' }))).rejects.toMatchObject({
      code: 'NETWORK_MISMATCH',
    })
    await expect(make('REGTEST').decodeInvoice(bolt11Fixture({ hrp: 'lnbc10u' }))).rejects.toMatchObject({
      code: 'NETWORK_MISMATCH',
    })
  })

  it('checks a local wallet against regtest invoices', async () => {
    vi.useFakeTimers({ now: NOW_MS })
    await expect(make('local').decodeInvoice(bolt11Fixture({ hrp: 'lnbcrt10u' }))).resolves.toMatchObject({ amount: 1000 })
    await expect(make('local').decodeInvoice(bolt11Fixture({ hrp: 'lnbc10u' }))).rejects.toMatchObject({
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

describe('Spark BOLT11 decode fails closed without a known network', () => {
  it('SparkAdapter refuses to decode before connect instead of assuming mainnet', async () => {
    vi.useFakeTimers({ now: NOW_MS })
    await expect(new SparkAdapter().decodeInvoice(bolt11Fixture({ hrp: 'lnbc10u' }))).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    })
  })

  it('SparkWdkAdapter refuses to decode before connect instead of assuming mainnet', async () => {
    vi.useFakeTimers({ now: NOW_MS })
    await expect(new SparkWdkAdapter().decodeInvoice(bolt11Fixture({ hrp: 'lnbc10u' }))).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    })
  })

  it.each(['', 'bogus', 'mutinynet', 'constructor', '__proto__'])('rejects wallet network %j with UNKNOWN_NETWORK', (network) => {
    vi.useFakeTimers({ now: NOW_MS })
    expect(() => decodeSparkBolt11(bolt11Fixture({ hrp: 'lnbc10u' }), network)).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_NETWORK' }),
    )
  })
})
