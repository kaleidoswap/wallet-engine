import { describe, expect, it, vi } from 'vitest'
import { ProtocolManager } from '../../src/manager/ProtocolManager'
import { RlnWdkAdapter } from '../../src/adapters/wdk/RlnWdkAdapter'

describe('G-F10 residual: balance refresh failures are observable additively', () => {
  it('an adapter refresh rejects when its sync fails', async () => {
    const adapter = new RlnWdkAdapter()
    Object.assign(adapter as never, {
      connected: true,
      account: { refreshTransfers: async () => { throw new Error('sync failed') } },
    })
    await expect(adapter.refreshBalances()).rejects.toThrow('sync failed')
  })

  it('manager reports per-protocol outcomes while legacy refresh remains tolerant', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const manager = new ProtocolManager({ logger })
    manager.registerAdapter({
      protocolName: 'BTC',
      isConnected: () => true,
      refreshBalances: async () => { throw new Error('sync failed') },
    } as never)

    await expect(manager.refreshBalances()).resolves.toBeUndefined()
    await expect((manager as any).refreshBalancesWithResults()).resolves.toEqual([
      expect.objectContaining({ protocol: 'BTC', ok: false, error: expect.any(Error) }),
    ])
  })
})
