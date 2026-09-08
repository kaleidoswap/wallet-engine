/**
 * TASK A audit probe [A-F9 FIXED] — ProtocolManager.disconnectAll() used to
 * resolve successfully after its 2s bounded timeout even when an adapter's
 * teardown never ran, leaving a live, still-connected (still signing-capable)
 * adapter reachable through getAdapter() — which is unrestricted when no policy
 * is configured (the default).
 *
 * The singular disconnect(protocol) path always propagated the timeout error;
 * only disconnectAll() downgraded it to a log line, so the "silent success"
 * scenario was the full-wallet lock/teardown path — exactly the path a host calls
 * on lock. disconnectAll() now REJECTS, naming the adapters that did not come
 * down, so a host cannot render a locked wallet over a live one.
 *
 * The still-reachable adapter is NOT closed by this fix and is asserted below:
 * disconnectAll does not unregister anything, so getAdapter() still returns the
 * stalled adapter. What changed is that the host is now told.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProtocolManager } from '../../src/manager/ProtocolManager'
import type { IProtocolAdapter } from '../../src/adapters/IProtocolAdapter'

afterEach(() => vi.useRealTimers())

describe('ProtocolManager stalled teardown', () => {
  it('F9: disconnectAll() reports success while the adapter is still connected and can still move funds', async () => {
    vi.useFakeTimers()
    let spent = false
    const adapter = {
      protocolName: 'BTC' as const,
      capabilities: [],
      supportedLayers: [],
      version: 'probe',
      connected: true,
      async connect() {},
      // Teardown that never settles (e.g. a hung SDK cleanupConnections()).
      async disconnect() {
        await new Promise<void>(() => {})
      },
      isConnected() {
        return this.connected
      },
      supportsSwaps: () => false,
      async sendPayment() {
        spent = true
        return { status: 'sent' }
      },
    }
    const manager = new ProtocolManager() // no policy -> raw adapter access allowed
    manager.registerAdapter(adapter as unknown as IProtocolAdapter)

    // Handler attached at creation: the rejection lands mid-`advanceTimers`.
    const disconnecting = manager.disconnectAll().catch((e: unknown) => e as Error)
    await vi.advanceTimersByTimeAsync(2_100)
    // Was: `await expect(disconnecting).resolves.toBeUndefined()` — the host's
    // "lock wallet" appeared to have worked. It now rejects, naming BTC.
    const err = await disconnecting
    expect(err.message).toMatch(/BTC/)
    expect(err.message).toMatch(/not fully locked/i)

    // Still true, and still asserted: the adapter was never torn down and is
    // reachable. That is what makes the rejection load-bearing.
    const raw = manager.getAdapter('BTC')
    expect(raw.isConnected()).toBe(true)
    await raw.sendPayment({ invoice: 'lnbc1…' } as never)
    expect(spent).toBe(true)
  })
})
