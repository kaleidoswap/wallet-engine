import { afterEach, describe, expect, it, vi } from 'vitest'
import { setOrchestraApiKey, submitOrder } from '../../src/lib/orchestra-client'

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
})
