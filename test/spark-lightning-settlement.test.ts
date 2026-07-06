import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  readLightningSettlement,
  waitForLightningSendSettlement,
} from '../src/lib/spark-lightning-settlement'

afterEach(() => {
  vi.useRealTimers()
})

describe('readLightningSettlement', () => {
  it('confirms on a success status and extracts preimage + sat fee', () => {
    const s = readLightningSettlement({
      status: 'LIGHTNING_PAYMENT_SUCCEEDED',
      paymentPreimage: 'ab'.repeat(32),
      fee: { originalValue: 3, originalUnit: 'SATOSHI' },
    })
    expect(s).toEqual({
      status: 'confirmed',
      rawStatus: 'LIGHTNING_PAYMENT_SUCCEEDED',
      preimage: 'ab'.repeat(32),
      feeSats: 3,
    })
  })

  it('confirms on preimage alone and converts msat fees', () => {
    const s = readLightningSettlement({
      status: 'PREIMAGE_PROVIDED',
      paymentPreimage: 'cd'.repeat(32),
      fee: { originalValue: 2100, originalUnit: 'MILLISATOSHI' },
    })
    expect(s?.status).toBe('confirmed')
    expect(s?.feeSats).toBe(3)
  })

  it('fails on failure statuses including the refund path', () => {
    for (const status of ['LIGHTNING_PAYMENT_FAILED', 'TRANSFER_FAILED', 'USER_SWAP_RETURNED']) {
      expect(readLightningSettlement({ status })?.status).toBe('failed')
    }
  })

  it('returns null while in flight', () => {
    for (const status of ['CREATED', 'REQUEST_VALIDATED', 'LIGHTNING_PAYMENT_INITIATED', '']) {
      expect(readLightningSettlement({ status })).toBeNull()
    }
  })
})

describe('waitForLightningSendSettlement', () => {
  it('returns immediately when the dispatch result is already terminal', async () => {
    const lookup = vi.fn()
    const s = await waitForLightningSendSettlement(
      { getLightningSendRequest: lookup },
      'id-1',
      { status: 'LIGHTNING_PAYMENT_SUCCEEDED', paymentPreimage: 'ee' },
    )
    expect(s.status).toBe('confirmed')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('polls until the request settles and returns the preimage', async () => {
    vi.useFakeTimers()
    const lookup = vi
      .fn()
      .mockResolvedValueOnce({ status: 'LIGHTNING_PAYMENT_INITIATED' })
      .mockResolvedValueOnce({ status: 'PREIMAGE_PROVIDED', paymentPreimage: 'ff'.repeat(32) })
    const promise = waitForLightningSendSettlement(
      { getLightningSendRequest: lookup },
      // WDK-style entity id — the bare uuid must be what reaches the lookup.
      'SparkLightningSendRequest:uuid-1',
      { status: 'CREATED' },
    )
    await vi.advanceTimersByTimeAsync(4_100)
    const s = await promise
    expect(s).toMatchObject({ status: 'confirmed', preimage: 'ff'.repeat(32) })
    expect(lookup).toHaveBeenCalledWith('uuid-1')
  })

  it('throws nothing and reports failed statuses from the poll', async () => {
    vi.useFakeTimers()
    const lookup = vi.fn().mockResolvedValue({ status: 'LIGHTNING_PAYMENT_FAILED' })
    const promise = waitForLightningSendSettlement(
      { getLightningSendRequest: lookup },
      'id-2',
      { status: 'CREATED' },
    )
    await vi.advanceTimersByTimeAsync(2_100)
    await expect(promise).resolves.toMatchObject({
      status: 'failed',
      rawStatus: 'LIGHTNING_PAYMENT_FAILED',
    })
  })

  it('resolves pending when no lookup is available', async () => {
    const s = await waitForLightningSendSettlement({}, 'id-3', { status: 'CREATED' })
    expect(s.status).toBe('pending')
  })

  it('resolves pending after the deadline without a terminal state', async () => {
    vi.useFakeTimers()
    const lookup = vi.fn().mockResolvedValue({ status: 'LIGHTNING_PAYMENT_INITIATED' })
    const promise = waitForLightningSendSettlement(
      { getLightningSendRequest: lookup },
      'id-4',
      { status: 'CREATED' },
    )
    await vi.advanceTimersByTimeAsync(46_000)
    await expect(promise).resolves.toMatchObject({
      status: 'pending',
      rawStatus: 'LIGHTNING_PAYMENT_INITIATED',
    })
  })
})
