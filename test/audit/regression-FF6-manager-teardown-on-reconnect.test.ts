/*
 * Regression test for audit finding F-F6, manager half (REPORT.md §2.2,
 * REPORT-2.md §4.2).
 *
 * `ProtocolManager.connect()` re-connected a live adapter with no teardown: the
 * registry returns the SAME adapter instance every time, and the method called
 * `adapter.connect(config)` on it directly. The previous wallet's client was
 * dropped undisposed. Run 1 identified this as "the mechanism that made A7
 * deterministic" — the cross-wallet leak where wallet B's session kept operating
 * on wallet A's client.
 *
 * Commit 32eea17 closed the harm ADAPTER-side, by having each of the six WDK
 * adapters call `releasePreviousConnection()` at the top of its own `connect()`.
 * It deliberately left the manager alone, because fixing it there changes
 * teardown ordering for every adapter including the three native ones. That is
 * this commit.
 *
 * The two are complementary, not redundant: the adapter-side hook also covers a
 * partially-constructed state (`account` set, `connected` still false) that the
 * manager cannot observe, and it protects an adapter driven directly rather than
 * through the manager. Once the manager has torn down, the hook early-returns.
 */
import { describe, expect, it, vi } from 'vitest'
import { ProtocolManager } from '../../src/manager/ProtocolManager'
import type { IProtocolAdapter } from '../../src/adapters/IProtocolAdapter'
import type { ProtocolType } from '../../src/types/base'

function stubAdapter(protocolName: ProtocolType, opts: { disconnect?: () => Promise<void> } = {}) {
  const state = {
    connected: false,
    order: [] as string[],
    connectCalls: [] as { config: unknown; wasAlreadyConnected: boolean }[],
    disconnectCalls: 0,
  }
  const adapter = {
    protocolName,
    capabilities: [],
    supportedLayers: [],
    version: 'test',
    async connect(config: unknown) {
      state.order.push('connect')
      state.connectCalls.push({ config, wasAlreadyConnected: state.connected })
      state.connected = true
    },
    async disconnect() {
      state.order.push('disconnect')
      state.disconnectCalls++
      state.connected = false
      if (opts.disconnect) await opts.disconnect()
    },
    isConnected: () => state.connected,
    supportsSwaps: () => false,
  }
  return { adapter: adapter as unknown as IProtocolAdapter, state }
}

describe('F-F6: ProtocolManager.connect() tears down the live session first', () => {
  it('a re-connect disconnects before it connects, in that order', async () => {
    const { adapter, state } = stubAdapter('SPARK')
    const manager = new ProtocolManager()
    manager.registerAdapter(adapter)

    await manager.connect('SPARK', { protocol: 'SPARK', mnemonic: 'wallet-A' } as never)
    await manager.connect('SPARK', { protocol: 'SPARK', mnemonic: 'wallet-B' } as never)

    expect(state.order).toEqual(['connect', 'disconnect', 'connect'])
    expect(state.connectCalls[1].wasAlreadyConnected).toBe(false)
  })

  it('a FIRST connect does not call disconnect on a fresh adapter', async () => {
    const { adapter, state } = stubAdapter('SPARK')
    const manager = new ProtocolManager()
    manager.registerAdapter(adapter)
    await manager.connect('SPARK', { protocol: 'SPARK' } as never)
    expect(state.order).toEqual(['connect'])
    expect(state.disconnectCalls).toBe(0)
  })

  it('an explicit disconnect between connects is not doubled', async () => {
    const { adapter, state } = stubAdapter('SPARK')
    const manager = new ProtocolManager()
    manager.registerAdapter(adapter)
    await manager.connect('SPARK', { protocol: 'SPARK' } as never)
    await manager.disconnect('SPARK')
    await manager.connect('SPARK', { protocol: 'SPARK' } as never)
    // The adapter is already down, so connect() skips its own teardown.
    expect(state.disconnectCalls).toBe(1)
    expect(state.order).toEqual(['connect', 'disconnect', 'connect'])
  })

  it('a failing previous teardown does not block the new connection', async () => {
    // `disconnect()` revokes local signing capability synchronously before
    // awaiting third-party cleanup, so a rejection means only that the OLD SDK's
    // cleanup failed. Refusing the new connect over that would wedge a host on
    // the wallet it is trying to leave.
    const { adapter, state } = stubAdapter('SPARK', {
      disconnect: async () => {
        throw new Error('previous SDK cleanup exploded')
      },
    })
    const manager = new ProtocolManager()
    manager.registerAdapter(adapter)

    await manager.connect('SPARK', { protocol: 'SPARK', mnemonic: 'wallet-A' } as never)
    await expect(
      manager.connect('SPARK', { protocol: 'SPARK', mnemonic: 'wallet-B' } as never),
    ).resolves.toBeUndefined()
    expect(state.connectCalls).toHaveLength(2)
    expect(adapter.isConnected()).toBe(true)
  })

  it('a HUNG previous teardown does not block the new connection either', async () => {
    vi.useFakeTimers()
    try {
      const { adapter, state } = stubAdapter('SPARK', {
        disconnect: () => new Promise<void>(() => {}),
      })
      const manager = new ProtocolManager()
      manager.registerAdapter(adapter)

      await manager.connect('SPARK', { protocol: 'SPARK', mnemonic: 'wallet-A' } as never)
      const reconnecting = manager.connect('SPARK', {
        protocol: 'SPARK',
        mnemonic: 'wallet-B',
      } as never)
      // The teardown is bounded by the same DISCONNECT_TIMEOUT_MS as everywhere else.
      await vi.advanceTimersByTimeAsync(2_100)
      await expect(reconnecting).resolves.toBeUndefined()
      expect(state.connectCalls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a connect superseded during its teardown does not go on to connect', async () => {
    // The generation guard is re-checked after the teardown await: a wallet
    // switch that lands while the PREVIOUS session is coming down must not have
    // the superseded config installed afterwards.
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { adapter, state } = stubAdapter('SPARK', { disconnect: () => gate })
    const manager = new ProtocolManager()
    manager.registerAdapter(adapter)

    await manager.connect('SPARK', { protocol: 'SPARK', mnemonic: 'wallet-A' } as never)
    const b = manager.connect('SPARK', { protocol: 'SPARK', mnemonic: 'wallet-B' } as never)
    // C supersedes B while B is still inside its teardown of A.
    await Promise.resolve()
    const c = manager.connect('SPARK', { protocol: 'SPARK', mnemonic: 'wallet-C' } as never)
    release()

    await expect(b).rejects.toThrow(/invalidated/i)
    await c
    // B never reached adapter.connect(): only A's and C's connects ran.
    const mnemonics = state.connectCalls.map((c) => (c.config as { mnemonic: string }).mnemonic)
    expect(mnemonics).toEqual(['wallet-A', 'wallet-C'])
  })
})
