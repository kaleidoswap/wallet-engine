import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStatus, setOrchestraApiKey } from '../../src/lib/orchestra-client'

afterEach(() => vi.unstubAllGlobals())

describe('B-F9: Orchestra null order is explicit', () => {
  it('rejects a wrapped lookup that contains no order', async () => {
    setOrchestraApiKey('test-key')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ quote: { quoteId: 'q1' }, order: null, stages: [] }),
    })))

    await expect(getStatus({ quoteId: 'q1' })).rejects.toMatchObject({
      name: 'OrchestraOrderNotFoundError',
      code: 'ORCHESTRA_ORDER_NOT_FOUND',
    })
  })
})
