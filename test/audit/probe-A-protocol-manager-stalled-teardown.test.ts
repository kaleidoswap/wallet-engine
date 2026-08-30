/**
 * TASK A audit probe — ProtocolManager.disconnectAll() resolves successfully
 * after a 2s bounded timeout even when an adapter's teardown never ran,
 * leaving a live, still-connected (still signing-capable) adapter reachable
 * through getAdapter() — which is unrestricted when no policy is configured
 * (the default; ProtocolManager.ts:96-97).
 *
 * Note: the singular disconnect(protocol) path DOES propagate the timeout
 * error to the caller; only disconnectAll() downgrades it to a log line
 * (ProtocolManager.ts:300-310), so the "silent success" scenario is the
 * full-wallet lock/teardown path — exactly the path a host calls on lock.
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

    const disconnecting = manager.disconnectAll()
    await vi.advanceTimersByTimeAsync(2_100)
    // Resolves WITHOUT error — the host's "lock wallet" appears to have worked
    // (the timeout is only logged, ProtocolManager.ts:305-309).
    await expect(disconnecting).resolves.toBeUndefined()

    // The adapter was never actually torn down and is still fully usable.
    const raw = manager.getAdapter('BTC')
    expect(raw.isConnected()).toBe(true)
    await raw.sendPayment({ invoice: 'lnbc1…' } as never)
    expect(spent).toBe(true)
  })
})
