import { afterEach, describe, expect, it, vi } from 'vitest'

const sparkState = vi.hoisted(() => ({ wallet: null as unknown }))
vi.mock('../src/lib/spark-client-manager', () => ({
  sparkClientManager: {
    isInitialized: () => sparkState.wallet !== null,
    ownsSession: () => sparkState.wallet !== null,
    getWallet: () => sparkState.wallet,
    getConfig: () => ({ protocol: 'SPARK', network: 'regtest', mnemonic: '' }),
    initialize: async () => Symbol('session'),
    disconnect: async () => {},
    adoptExternalWallet: () => {},
    releaseExternalWallet: () => {},
  },
}))

import { SparkAdapter } from '../src/adapters/SparkAdapter'
import { SparkWdkAdapter } from '../src/adapters/wdk/SparkWdkAdapter'
import { bolt11Fixture, TEST_PREIMAGE } from './fixtures/bolt11'

/**
 * Security review 2026-10-28, finding 16: a Spark Lightning send is `confirmed`
 * only on a preimage whose SHA-256 is the payment hash of the invoice we sent.
 * An SSP success status with an empty or unrelated preimage, or a record for a
 * different request/invoice, must never surface as a paid invoice to WebLN/NWC
 * consumers.
 */
const INVOICE = bolt11Fixture({ hrp: 'lnbc1m' })
const OTHER_INVOICE = bolt11Fixture({ hrp: 'lnbc2m' })
const UNRELATED_PREIMAGE = 'ab'.repeat(32)
const REQ_ID = 'SparkLightningSendRequest:01a0f985-c175-e342-0000-c36adb788a8a'
const UUID = '01a0f985-c175-e342-0000-c36adb788a8a'

function sendRequest(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: REQ_ID,
    createdAt: '2026-10-02T10:00:00.000Z',
    encodedInvoice: INVOICE,
    fee: { originalValue: 1, originalUnit: 'SATOSHI' },
    status,
    ...extra,
  }
}

/** Raw SDK wallet: `dispatched` answers payLightningInvoice, `polled` every status lookup. */
function sspWallet(dispatched: Record<string, unknown>, polled: Record<string, unknown> | null = dispatched) {
  return {
    payLightningInvoice: vi.fn(async () => dispatched),
    getLightningSendRequest: vi.fn(async () => polled),
  }
}

function nativeAdapter(wallet: unknown) {
  sparkState.wallet = wallet
  const adapter = new SparkAdapter()
  Object.assign(adapter as any, { connected: true })
  return adapter
}

function wdkAdapter(wallet: any) {
  const adapter = new SparkWdkAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account: { payLightningInvoice: wallet.payLightningInvoice, _wallet: wallet },
  })
  return adapter
}

/** Drive sendPayment through the settlement poller's full deadline. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(46_000)
  return promise
}

afterEach(() => {
  sparkState.wallet = null
  vi.useRealTimers()
})

describe.each([
  ['SparkAdapter', nativeAdapter],
  ['SparkWdkAdapter', wdkAdapter],
] as const)('%s Lightning settlement proof', (_name, make) => {
  it('confirms with the preimage of the invoice payment hash', async () => {
    const wallet = sspWallet(sendRequest('LIGHTNING_PAYMENT_SUCCEEDED', { paymentPreimage: TEST_PREIMAGE }))
    const result = await make(wallet).sendPayment({ invoice: INVOICE } as any)
    expect(result).toMatchObject({ paymentHash: REQ_ID, status: 'confirmed', preimage: TEST_PREIMAGE, fee: 1 })
    expect(wallet.getLightningSendRequest).not.toHaveBeenCalled()
  })

  it('confirms once the poll delivers the preimage after a success status', async () => {
    vi.useFakeTimers()
    const wallet = sspWallet(sendRequest('LIGHTNING_PAYMENT_SUCCEEDED'))
    wallet.getLightningSendRequest
      .mockResolvedValueOnce(sendRequest('LIGHTNING_PAYMENT_SUCCEEDED'))
      .mockResolvedValueOnce(sendRequest('PREIMAGE_PROVIDED', { paymentPreimage: TEST_PREIMAGE }))
    const promise = make(wallet).sendPayment({ invoice: INVOICE } as any)
    await vi.advanceTimersByTimeAsync(4_100)
    await expect(promise).resolves.toMatchObject({ status: 'confirmed', preimage: TEST_PREIMAGE })
    expect(wallet.getLightningSendRequest).toHaveBeenCalledWith(UUID)
  })

  it('reports pending, not confirmed, on a success status with an empty preimage', async () => {
    vi.useFakeTimers()
    const wallet = sspWallet(sendRequest('TRANSFER_COMPLETED'))
    const result = await settle(make(wallet).sendPayment({ invoice: INVOICE } as any))
    expect(result).toMatchObject({ paymentHash: REQ_ID, status: 'pending', preimage: '' })
  })

  it('reports pending, not confirmed, on a success status with an unrelated preimage', async () => {
    vi.useFakeTimers()
    const wallet = sspWallet(sendRequest('PREIMAGE_PROVIDED', { paymentPreimage: UNRELATED_PREIMAGE }))
    const result = await settle(make(wallet).sendPayment({ invoice: INVOICE } as any))
    expect(result).toMatchObject({ status: 'pending', preimage: '' })
  })

  it('rejects a polled record for a different invoice, even with its own valid preimage', async () => {
    vi.useFakeTimers()
    const wallet = sspWallet(
      sendRequest('CREATED'),
      sendRequest('PREIMAGE_PROVIDED', { encodedInvoice: OTHER_INVOICE, paymentPreimage: TEST_PREIMAGE }),
    )
    const result = await settle(make(wallet).sendPayment({ invoice: INVOICE } as any))
    expect(result).toMatchObject({ status: 'pending', preimage: '' })
  })

  it('rejects a dispatch response for a different invoice', async () => {
    vi.useFakeTimers()
    const foreign = sendRequest('PREIMAGE_PROVIDED', { encodedInvoice: OTHER_INVOICE, paymentPreimage: TEST_PREIMAGE })
    const result = await settle(make(sspWallet(foreign)).sendPayment({ invoice: INVOICE } as any))
    expect(result).toMatchObject({ status: 'pending', preimage: '' })
  })

  it('refuses to dispatch an invoice whose payment hash cannot be decoded', async () => {
    const wallet = sspWallet(sendRequest('LIGHTNING_PAYMENT_SUCCEEDED', { paymentPreimage: TEST_PREIMAGE }))
    await expect(make(wallet).sendPayment({ invoice: 'lnbc1m1pexample' } as any)).rejects.toThrow(
      /payment hash cannot be decoded/,
    )
    expect(wallet.payLightningInvoice).not.toHaveBeenCalled()
  })

  it('polls status as confirmed only with the preimage for the record invoice', async () => {
    const paid = sspWallet(sendRequest('CREATED'), sendRequest('TRANSFER_COMPLETED', { paymentPreimage: TEST_PREIMAGE }))
    await expect(make(paid).getPaymentStatus(REQ_ID)).resolves.toMatchObject({ status: 'confirmed', fee: 1 })

    const claimed = sspWallet(sendRequest('CREATED'), sendRequest('TRANSFER_COMPLETED'))
    await expect(make(claimed).getPaymentStatus(REQ_ID)).resolves.toMatchObject({ status: 'pending' })

    const unrelated = sspWallet(
      sendRequest('CREATED'),
      sendRequest('TRANSFER_COMPLETED', { paymentPreimage: UNRELATED_PREIMAGE }),
    )
    await expect(make(unrelated).getPaymentStatus(REQ_ID)).resolves.toMatchObject({ status: 'pending' })
  })

  it('does not report status from a polled record for another request', async () => {
    const wallet = sspWallet(
      sendRequest('CREATED'),
      sendRequest('TRANSFER_COMPLETED', { id: 'other-id', paymentPreimage: TEST_PREIMAGE }),
    )
    const status = await make(wallet).getPaymentStatus(REQ_ID).then(
      (s) => s.status,
      (err: Error) => err.message,
    )
    // Native: not found; WDK: unknown. Neither is `confirmed`.
    expect(status).toMatch(/^unknown$|Payment not found/)
  })
})
