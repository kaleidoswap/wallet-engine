import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getLightningSendStatus,
  lightningInvoicePaymentHash,
  lightningSendRecordMatches,
  readLightningSettlement,
  waitForLightningSendSettlement,
} from '../src/lib/spark-lightning-settlement'
import { bolt11Fixture, TEST_PAYMENT_HASH, TEST_PREIMAGE } from './fixtures/bolt11'

/**
 * A Spark SSP status is a claim, not a proof: the only evidence that an invoice
 * was paid is a preimage whose SHA-256 is the invoice's payment hash. A record
 * for another request or another invoice is never this payment.
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
    fee: { originalValue: 3, originalUnit: 'SATOSHI' },
    status,
    ...extra,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('lightningInvoicePaymentHash', () => {
  it('reads the payment hash of a valid invoice and null for garbage', () => {
    expect(lightningInvoicePaymentHash(INVOICE)).toBe(TEST_PAYMENT_HASH)
    expect(lightningInvoicePaymentHash(INVOICE.toUpperCase())).toBe(TEST_PAYMENT_HASH)
    expect(lightningInvoicePaymentHash('lnbc1m1pexample')).toBeNull()
    expect(lightningInvoicePaymentHash('')).toBeNull()
  })
})

describe('lightningSendRecordMatches', () => {
  it('binds by request id in either entity form and by invoice, case-insensitively', () => {
    const req = sendRequest('CREATED')
    expect(lightningSendRecordMatches(req, { id: REQ_ID })).toBe(true)
    expect(lightningSendRecordMatches(req, { id: UUID })).toBe(true)
    expect(lightningSendRecordMatches({ ...req, id: UUID }, { id: REQ_ID })).toBe(true)
    expect(lightningSendRecordMatches(req, { invoice: INVOICE.toUpperCase() })).toBe(true)
    expect(lightningSendRecordMatches(req, { id: 'other-id' })).toBe(false)
    expect(lightningSendRecordMatches(req, { invoice: OTHER_INVOICE })).toBe(false)
    expect(lightningSendRecordMatches(req, { id: REQ_ID, invoice: OTHER_INVOICE })).toBe(false)
  })
})

describe('readLightningSettlement', () => {
  it('confirms a success status whose preimage hashes to the invoice payment hash', () => {
    const s = readLightningSettlement(
      sendRequest('LIGHTNING_PAYMENT_SUCCEEDED', { paymentPreimage: TEST_PREIMAGE }),
      { id: REQ_ID, invoice: INVOICE, paymentHash: TEST_PAYMENT_HASH },
    )
    expect(s).toEqual({
      status: 'confirmed',
      rawStatus: 'LIGHTNING_PAYMENT_SUCCEEDED',
      preimage: TEST_PREIMAGE,
      feeSats: 3,
    })
  })

  it('derives the payment hash from the bound invoice, else from the record invoice', () => {
    const req = sendRequest('PREIMAGE_PROVIDED', { paymentPreimage: TEST_PREIMAGE.toUpperCase() })
    expect(readLightningSettlement(req, { invoice: INVOICE })?.status).toBe('confirmed')
    expect(readLightningSettlement(req, {})).toMatchObject({ status: 'confirmed', preimage: TEST_PREIMAGE })
  })

  it('does not confirm a success status with an empty preimage', () => {
    for (const status of ['LIGHTNING_PAYMENT_SUCCEEDED', 'PREIMAGE_PROVIDED', 'TRANSFER_COMPLETED']) {
      expect(readLightningSettlement(sendRequest(status), { invoice: INVOICE })).toBeNull()
      expect(readLightningSettlement(sendRequest(status, { paymentPreimage: '' }), { invoice: INVOICE })).toBeNull()
    }
  })

  it('does not confirm a success status with an unrelated or malformed preimage', () => {
    const binding = { invoice: INVOICE, paymentHash: TEST_PAYMENT_HASH }
    for (const preimage of [UNRELATED_PREIMAGE, TEST_PREIMAGE.slice(2), `${TEST_PREIMAGE}00`, 'not-hex', 'ee']) {
      expect(
        readLightningSettlement(sendRequest('TRANSFER_COMPLETED', { paymentPreimage: preimage }), binding),
      ).toBeNull()
    }
  })

  it('never confirms on a preimage alone when no payment hash can be read', () => {
    const req = { id: REQ_ID, status: 'PREIMAGE_PROVIDED', paymentPreimage: TEST_PREIMAGE }
    expect(readLightningSettlement(req)).toBeNull()
    expect(readLightningSettlement({ ...req, encodedInvoice: 'lnbc1m1pexample' })).toBeNull()
  })

  it('ignores a record for another request or another invoice', () => {
    const paid = sendRequest('TRANSFER_COMPLETED', { paymentPreimage: TEST_PREIMAGE })
    expect(readLightningSettlement(paid, { id: 'other-id' })).toBeNull()
    expect(readLightningSettlement(paid, { invoice: OTHER_INVOICE })).toBeNull()
    // A record claiming another invoice is not ours even when the preimage fits our hash.
    expect(
      readLightningSettlement(
        { ...paid, encodedInvoice: OTHER_INVOICE },
        { invoice: INVOICE, paymentHash: TEST_PAYMENT_HASH },
      ),
    ).toBeNull()
  })

  it('converts msat fees on a confirmed settlement', () => {
    const s = readLightningSettlement(
      sendRequest('PREIMAGE_PROVIDED', {
        paymentPreimage: TEST_PREIMAGE,
        fee: { originalValue: 2100, originalUnit: 'MILLISATOSHI' },
      }),
      { invoice: INVOICE },
    )
    expect(s?.status).toBe('confirmed')
    expect(s?.feeSats).toBe(3)
  })

  it('fails on failure statuses including the refund path', () => {
    for (const status of ['LIGHTNING_PAYMENT_FAILED', 'TRANSFER_FAILED', 'USER_SWAP_RETURNED']) {
      expect(readLightningSettlement(sendRequest(status), { invoice: INVOICE })?.status).toBe('failed')
    }
  })

  it('returns null while in flight', () => {
    for (const status of ['CREATED', 'REQUEST_VALIDATED', 'LIGHTNING_PAYMENT_INITIATED', '']) {
      expect(readLightningSettlement(sendRequest(status), { invoice: INVOICE })).toBeNull()
    }
  })
})

describe('waitForLightningSendSettlement', () => {
  const binding = { invoice: INVOICE, paymentHash: TEST_PAYMENT_HASH }

  it('returns immediately when the dispatch result already carries the proof', async () => {
    const lookup = vi.fn()
    const s = await waitForLightningSendSettlement(
      { getLightningSendRequest: lookup },
      REQ_ID,
      sendRequest('LIGHTNING_PAYMENT_SUCCEEDED', { paymentPreimage: TEST_PREIMAGE }),
      binding,
    )
    expect(s.status).toBe('confirmed')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('polls until the request settles and returns the preimage', async () => {
    vi.useFakeTimers()
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(sendRequest('LIGHTNING_PAYMENT_INITIATED'))
      .mockResolvedValueOnce(sendRequest('PREIMAGE_PROVIDED', { paymentPreimage: TEST_PREIMAGE }))
    const promise = waitForLightningSendSettlement(
      { getLightningSendRequest: lookup },
      // WDK-style entity id — the bare uuid must be what reaches the lookup.
      REQ_ID,
      sendRequest('CREATED'),
      binding,
    )
    await vi.advanceTimersByTimeAsync(4_100)
    const s = await promise
    expect(s).toMatchObject({ status: 'confirmed', preimage: TEST_PREIMAGE })
    expect(lookup).toHaveBeenCalledWith(UUID)
  })

  it('keeps polling past a success status until the invoice-bound preimage arrives', async () => {
    vi.useFakeTimers()
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(sendRequest('LIGHTNING_PAYMENT_SUCCEEDED'))
      .mockResolvedValueOnce(sendRequest('LIGHTNING_PAYMENT_SUCCEEDED', { paymentPreimage: '' }))
      .mockResolvedValueOnce(sendRequest('PREIMAGE_PROVIDED', { paymentPreimage: TEST_PREIMAGE }))
    const promise = waitForLightningSendSettlement(
      { getLightningSendRequest: lookup },
      REQ_ID,
      sendRequest('LIGHTNING_PAYMENT_SUCCEEDED'),
      binding,
    )
    await vi.advanceTimersByTimeAsync(6_100)
    await expect(promise).resolves.toMatchObject({ status: 'confirmed', preimage: TEST_PREIMAGE })
    expect(lookup).toHaveBeenCalledTimes(3)
  })

  it('reports pending, never confirmed, when success comes with an empty preimage', async () => {
    vi.useFakeTimers()
    const lookup = vi.fn().mockResolvedValue(sendRequest('TRANSFER_COMPLETED'))
    const promise = waitForLightningSendSettlement(
      { getLightningSendRequest: lookup },
      REQ_ID,
      sendRequest('TRANSFER_COMPLETED'),
      binding,
    )
    await vi.advanceTimersByTimeAsync(46_000)
    await expect(promise).resolves.toEqual({
      status: 'pending',
      rawStatus: 'TRANSFER_COMPLETED',
      preimage: '',
      feeSats: 0,
    })
  })

  it('reports pending, never confirmed, when success comes with an unrelated preimage', async () => {
    vi.useFakeTimers()
    const lookup = vi
      .fn()
      .mockResolvedValue(sendRequest('PREIMAGE_PROVIDED', { paymentPreimage: UNRELATED_PREIMAGE }))
    const promise = waitForLightningSendSettlement(
      { getLightningSendRequest: lookup },
      REQ_ID,
      sendRequest('PREIMAGE_PROVIDED', { paymentPreimage: UNRELATED_PREIMAGE }),
      binding,
    )
    await vi.advanceTimersByTimeAsync(46_000)
    await expect(promise).resolves.toMatchObject({ status: 'pending', preimage: '' })
  })

  it('ignores a polled record for another invoice, even one carrying its own valid proof', async () => {
    vi.useFakeTimers()
    const lookup = vi
      .fn()
      .mockResolvedValue(
        sendRequest('PREIMAGE_PROVIDED', { encodedInvoice: OTHER_INVOICE, paymentPreimage: TEST_PREIMAGE }),
      )
    const promise = waitForLightningSendSettlement(
      { getLightningSendRequest: lookup },
      REQ_ID,
      sendRequest('CREATED'),
      binding,
    )
    await vi.advanceTimersByTimeAsync(46_000)
    // The foreign record is dropped entirely: it does not even become `last`.
    await expect(promise).resolves.toMatchObject({ status: 'pending', rawStatus: 'CREATED', preimage: '' })
  })

  it('ignores a polled record for another request id, including its failure status', async () => {
    vi.useFakeTimers()
    const lookup = vi.fn().mockResolvedValue(sendRequest('LIGHTNING_PAYMENT_FAILED', { id: 'other-id' }))
    const promise = waitForLightningSendSettlement(
      { getLightningSendRequest: lookup },
      REQ_ID,
      sendRequest('CREATED'),
      binding,
    )
    await vi.advanceTimersByTimeAsync(46_000)
    await expect(promise).resolves.toMatchObject({ status: 'pending', rawStatus: 'CREATED' })
  })

  it('does not read a dispatch result for another invoice as settled', async () => {
    const s = await waitForLightningSendSettlement(
      {},
      REQ_ID,
      sendRequest('PREIMAGE_PROVIDED', { encodedInvoice: OTHER_INVOICE, paymentPreimage: TEST_PREIMAGE }),
      binding,
    )
    expect(s.status).toBe('pending')
  })

  it('throws nothing and reports failed statuses from the poll', async () => {
    vi.useFakeTimers()
    const lookup = vi.fn().mockResolvedValue(sendRequest('LIGHTNING_PAYMENT_FAILED'))
    const promise = waitForLightningSendSettlement(
      { getLightningSendRequest: lookup },
      REQ_ID,
      sendRequest('CREATED'),
      binding,
    )
    await vi.advanceTimersByTimeAsync(2_100)
    await expect(promise).resolves.toMatchObject({
      status: 'failed',
      rawStatus: 'LIGHTNING_PAYMENT_FAILED',
    })
  })

  it('resolves pending when no lookup is available', async () => {
    const s = await waitForLightningSendSettlement({}, REQ_ID, sendRequest('CREATED'), binding)
    expect(s.status).toBe('pending')
  })

  it('resolves pending after the deadline without a terminal state', async () => {
    vi.useFakeTimers()
    const lookup = vi.fn().mockResolvedValue(sendRequest('LIGHTNING_PAYMENT_INITIATED'))
    const promise = waitForLightningSendSettlement(
      { getLightningSendRequest: lookup },
      REQ_ID,
      sendRequest('CREATED'),
      binding,
    )
    await vi.advanceTimersByTimeAsync(46_000)
    await expect(promise).resolves.toMatchObject({
      status: 'pending',
      rawStatus: 'LIGHTNING_PAYMENT_INITIATED',
    })
  })
})

describe('getLightningSendStatus', () => {
  function walletReturning(req: unknown) {
    return { getLightningSendRequest: vi.fn().mockResolvedValue(req) }
  }

  it('confirms only with a preimage for the record invoice', async () => {
    const paid = walletReturning(sendRequest('TRANSFER_COMPLETED', { paymentPreimage: TEST_PREIMAGE }))
    await expect(getLightningSendStatus(paid, REQ_ID)).resolves.toMatchObject({ status: 'confirmed', feeSats: 3 })
    expect(paid.getLightningSendRequest).toHaveBeenCalledWith(UUID)

    const claimed = walletReturning(sendRequest('TRANSFER_COMPLETED'))
    await expect(getLightningSendStatus(claimed, REQ_ID)).resolves.toMatchObject({ status: 'pending' })

    const unrelated = walletReturning(sendRequest('TRANSFER_COMPLETED', { paymentPreimage: UNRELATED_PREIMAGE }))
    await expect(getLightningSendStatus(unrelated, REQ_ID)).resolves.toMatchObject({ status: 'pending' })
  })

  it('rejects a record for another request id or another invoice', async () => {
    const otherId = walletReturning(
      sendRequest('TRANSFER_COMPLETED', { id: 'other-id', paymentPreimage: TEST_PREIMAGE }),
    )
    await expect(getLightningSendStatus(otherId, REQ_ID)).resolves.toBeNull()

    const otherInvoice = walletReturning(sendRequest('TRANSFER_COMPLETED', { paymentPreimage: TEST_PREIMAGE }))
    await expect(getLightningSendStatus(otherInvoice, REQ_ID, { invoice: OTHER_INVOICE })).resolves.toBeNull()
  })

  it('reports failed statuses and null when the SSP does not know the id', async () => {
    const failed = walletReturning(sendRequest('USER_SWAP_RETURNED'))
    await expect(getLightningSendStatus(failed, REQ_ID)).resolves.toMatchObject({ status: 'failed' })
    await expect(getLightningSendStatus(walletReturning(null), REQ_ID)).resolves.toBeNull()
    await expect(getLightningSendStatus({}, REQ_ID)).resolves.toBeNull()
  })
})
