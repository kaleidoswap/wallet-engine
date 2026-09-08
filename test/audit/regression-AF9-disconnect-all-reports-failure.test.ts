/*
 * Regression test for audit finding A-F9 (REPORT.md §2.2, REPORT-2.md §4.2).
 *
 * `disconnectAll()` is the LOCK PATH — CHANGELOG.md names it that way in the
 * entry about a locked wallet no longer being able to sign. It ran every
 * adapter's teardown under a 2s bound via `Promise.allSettled`, then downgraded
 * every rejection to `log.error` and RESOLVED. A host awaiting it therefore
 * showed a locked wallet while a stalled adapter was still connected, still
 * reachable through `getAdapter()`, and still able to spend.
 *
 * The singular `disconnect(protocol)` always propagated its timeout. Only the
 * all-adapters path swallowed it, which is the path a host calls on lock.
 *
 * It now rejects, naming the adapters that did not come down. What it does NOT
 * do — and the cases below pin both halves — is give up early: every adapter is
 * still attempted, in parallel, under the same bound, so one hung SDK cannot
 * keep the others connected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProtocolManager } from '../../src/manager/ProtocolManager'
import type { IProtocolAdapter } from '../../src/adapters/IProtocolAdapter'
import type { ProtocolType } from '../../src/types/base'
import { ProtocolError } from '../../src/types/base'

afterEach(() => vi.useRealTimers())

function adapter(
  protocolName: ProtocolType,
  disconnect: () => Promise<void>,
): IProtocolAdapter & { connected: boolean } {
  return {
    protocolName,
    capabilities: [],
    supportedLayers: [],
    version: 'test',
    connected: true,
    async connect() {},
    disconnect,
    async getConnectionInfo() {
      return { protocol: protocolName, connected: (this as { connected: boolean }).connected }
    },
    isConnected() {
      return (this as { connected: boolean }).connected
    },
    supportsSwaps: () => false,
  } as unknown as IProtocolAdapter & { connected: boolean }
}

/** Comes down cleanly. */
function healthy(protocolName: ProtocolType) {
  const a = adapter(protocolName, async () => {
    a.connected = false
  })
  return a
}
/** Teardown never settles — a hung SDK cleanup. */
function stalled(protocolName: ProtocolType) {
  return adapter(protocolName, () => new Promise<void>(() => {}))
}
/** Teardown rejects outright. */
function throwing(protocolName: ProtocolType) {
  return adapter(protocolName, async () => {
    throw new Error('cleanup exploded')
  })
}

describe('A-F9: disconnectAll() must not report a successful lock over a live adapter', () => {
  it('rejects when an adapter stalls past the bound', async () => {
    vi.useFakeTimers()
    const manager = new ProtocolManager()
    manager.registerAdapter(stalled('BTC'))

    const disconnecting = manager.disconnectAll().catch((e: unknown) => e as Error)
    await vi.advanceTimersByTimeAsync(2_100)

    const err = await disconnecting
    expect(err).toBeInstanceOf(ProtocolError)
    expect(err.message).toMatch(/BTC/)
    expect(err.message).toMatch(/not fully locked/i)
  })

  it('rejects when an adapter\'s teardown throws', async () => {
    const manager = new ProtocolManager()
    manager.registerAdapter(throwing('SPARK'))
    await expect(manager.disconnectAll()).rejects.toThrow(/SPARK/)
  })

  it('carries the failing protocols and their reasons on the error', async () => {
    const manager = new ProtocolManager()
    manager.registerAdapter(throwing('SPARK'))
    manager.registerAdapter(throwing('ARKADE'))

    const err = await manager.disconnectAll().catch((e: unknown) => e as ProtocolError)
    expect(err).toBeInstanceOf(ProtocolError)
    expect(err.code).toBe('DISCONNECT_INCOMPLETE')
    const details = err.details as { protocol: ProtocolType; reason: unknown }[]
    expect(details.map((d) => d.protocol).sort()).toEqual(['ARKADE', 'SPARK'])
    expect(String((details[0].reason as Error).message)).toMatch(/cleanup exploded/)
  })

  it('still tears down every OTHER adapter — one hung SDK does not keep the rest alive', async () => {
    vi.useFakeTimers()
    const hung = stalled('BTC')
    const ok1 = healthy('SPARK')
    const ok2 = healthy('ARKADE')
    const manager = new ProtocolManager()
    for (const a of [hung, ok1, ok2]) manager.registerAdapter(a)

    const disconnecting = manager.disconnectAll().catch((e: unknown) => e as Error)
    // The healthy adapters come down immediately, not after the bound.
    await Promise.resolve()
    expect(ok1.isConnected()).toBe(false)
    expect(ok2.isConnected()).toBe(false)
    expect(manager.getActiveProtocol()).toBeNull()

    await vi.advanceTimersByTimeAsync(2_100)
    const err = await disconnecting
    expect(err.message).toMatch(/BTC/)
    // …and only the hung one is named.
    expect(err.message).not.toMatch(/SPARK|ARKADE/)
  })

  it('still resolves when every adapter comes down', async () => {
    const manager = new ProtocolManager()
    const a = healthy('SPARK')
    const b = healthy('ARKADE')
    manager.registerAdapter(a)
    manager.registerAdapter(b)

    await expect(manager.disconnectAll()).resolves.toBeUndefined()
    expect(a.isConnected()).toBe(false)
    expect(b.isConnected()).toBe(false)
    expect(manager.getActiveProtocol()).toBeNull()
  })

  it('resolves for a manager with no adapters at all', async () => {
    await expect(new ProtocolManager().disconnectAll()).resolves.toBeUndefined()
  })

  it('the rejection is diagnosable: getAllConnectionInfo names what is still up', async () => {
    vi.useFakeTimers()
    const manager = new ProtocolManager()
    manager.registerAdapter(stalled('BTC'))
    manager.registerAdapter(healthy('SPARK'))

    const disconnecting = manager.disconnectAll().catch((e: unknown) => e as Error)
    await vi.advanceTimersByTimeAsync(2_100)
    expect((await disconnecting).message).toMatch(/BTC/)

    // A host that catches the rejection can find out what is still live.
    vi.useRealTimers() // getAllConnectionInfo has its own timeout race
    const info = await manager.getAllConnectionInfo()
    expect([...info.keys()], 'only the adapter that failed to come down').toEqual(['BTC'])
  })
})
