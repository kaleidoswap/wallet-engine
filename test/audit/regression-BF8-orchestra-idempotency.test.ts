import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOrchestraQuoteAttemptId,
  createQuote,
  setOrchestraApiKey,
  submitOrder,
} from '../../src/lib/orchestra-client'
import { setPlatform } from '../../src/ports'

afterEach(() => vi.unstubAllGlobals())

async function submittedKeys(requests: Array<Parameters<typeof submitOrder>[0]>): Promise<string[]> {
  const keys: string[] = []
  setOrchestraApiKey('test-key')
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    keys.push((init.headers as Record<string, string>)['X-Idempotency-Key'])
    return { ok: true, json: async () => ({ orderId: 'o1', status: 'processing' }) }
  }))
  for (const request of requests) await submitOrder(request)
  return keys
}

describe('B-F8: Orchestra retries carry a stable idempotency key', () => {
  it('uses the same key for the same quote and deposit proof', async () => {
    const keys = await submittedKeys([
      { quoteId: 'q1', txHash: 'tx1' },
      { txHash: 'tx1', quoteId: 'q1' },
    ])
    expect(keys[0]).toBe(keys[1])
  })

  it('uses a different key for a distinct deposit proof', async () => {
    const keys = await submittedKeys([
      { quoteId: 'q1', txHash: 'tx1' },
      { quoteId: 'q1', txHash: 'tx2' },
    ])
    expect(keys[0]).not.toBe(keys[1])
  })

  it('reuses a quote key for one attempt but not for a second intentional quote', async () => {
    const keys: string[] = []
    const bodies: Array<Record<string, unknown>> = []
    setOrchestraApiKey('test-key')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)['X-Idempotency-Key'])
      bodies.push(JSON.parse(String(init.body)))
      return { ok: true, json: async () => ({ quoteId: 'q1' }) }
    }))
    const base = {
      sourceChain: 'ethereum',
      sourceAsset: 'USDC',
      destinationChain: 'spark',
      destinationAsset: 'BTC',
      amount: '100',
      recipientAddress: 'spark1recipient',
    }

    await createQuote({ ...base, attemptId: 'attempt-1' })
    await createQuote({ ...base, attemptId: 'attempt-1' })
    await createQuote({ ...base, attemptId: 'attempt-2' })

    expect(keys[0]).toBe(keys[1])
    expect(keys[2]).not.toBe(keys[0])
    expect(bodies.every((body) => !('attemptId' in body))).toBe(true)
  })

  it('creates attempt IDs from the injected runtime random source', () => {
    let fill = 1
    setPlatform({
      storage: {} as never,
      runtime: {
        host: 'node',
        now: () => 0,
        randomBytes: (length) => new Uint8Array(length).fill(fill++),
      },
    })

    expect(createOrchestraQuoteAttemptId()).toBe('01'.repeat(16))
    expect(createOrchestraQuoteAttemptId()).toBe('02'.repeat(16))
  })
})
