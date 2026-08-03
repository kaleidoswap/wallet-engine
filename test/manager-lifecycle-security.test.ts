import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProtocolManager } from '../src/manager/ProtocolManager'
import type { IProtocolAdapter } from '../src/adapters/IProtocolAdapter'
import type { ProtocolType } from '../src/types/base'

function lifecycleAdapter(
  protocolName: ProtocolType,
  hooks: {
    connect?: () => Promise<void>
    disconnect?: () => Promise<void>
  } = {},
): IProtocolAdapter & { connected: boolean } {
  const adapter = {
    protocolName,
    capabilities: [],
    supportedLayers: [],
    version: 'test',
    connected: false,
    async connect() {
      await hooks.connect?.()
      adapter.connected = true
    },
    async disconnect() {
      adapter.connected = false
      await hooks.disconnect?.()
    },
    isConnected: () => adapter.connected,
    supportsSwaps: () => false,
  }
  return adapter as unknown as IProtocolAdapter & { connected: boolean }
}

afterEach(() => vi.useRealTimers())

describe('ProtocolManager lifecycle ownership', () => {
  it('does not let a pending connect reactivate the wallet after disconnectAll', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter = lifecycleAdapter('BTC', { connect: () => gate })
    const manager = new ProtocolManager()
    manager.registerAdapter(adapter)

    const connecting = manager.connect('BTC', { protocol: 'BTC' })
    await Promise.resolve()
    await manager.disconnectAll()
    release()

    await expect(connecting).rejects.toMatchObject({ code: 'CONNECTION_INVALIDATED' })
    expect(adapter.isConnected()).toBe(false)
    expect(manager.getActiveProtocol()).toBeNull()
  })

  it('disconnects adapters concurrently and bounds a stalled teardown', async () => {
    vi.useFakeTimers()
    const stalled = lifecycleAdapter('BTC', {
      disconnect: () => new Promise<void>(() => {}),
    })
    const second = lifecycleAdapter('SPARK')
    stalled.connected = true
    second.connected = true
    const manager = new ProtocolManager()
    manager.registerAdapter(stalled)
    manager.registerAdapter(second)

    const disconnecting = manager.disconnectAll()
    await Promise.resolve()
    expect(second.isConnected()).toBe(false)
    expect(manager.getActiveProtocol()).toBeNull()

    await vi.advanceTimersByTimeAsync(2_001)
    await expect(disconnecting).resolves.toBeUndefined()
  })
})
