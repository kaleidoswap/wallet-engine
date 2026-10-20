/**
 * TASK A audit probes — two cross-wallet identity bugs:
 *
 *  F7: ArkadeSwapsClientManager wallet-switch identity. Removed with the Boltz
 *      swaps integration; only F8 remains.
 *
 *  F8: FlashnetClientManager.initialize() reuses an in-flight initPromise
 *      with no wallet-identity check, so a wallet switch (initialize(B)
 *      while initialize(A) is pending) is silently dropped and the Flashnet
 *      client stays bound to wallet A's SparkWallet (and its keys).
 *      (The disconnect-during-init path was checked and is safe: the client
 *      is assigned before the awaited SDK init, so disconnect() nulls it.)
 *
 * Self-contained: the SDK is module-mocked; no network access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// --- Mock @flashnet/sdk -----------------------------------------------------

const flashnetState = {
  pending: [] as Array<{ wallet: unknown; resolve: () => void }>,
}

vi.mock('@flashnet/sdk', () => {
  class FakeFlashnetClient {
    wallet: unknown
    constructor(wallet: unknown) {
      this.wallet = wallet
    }
    initialize(): Promise<void> {
      return new Promise<void>((resolve) => {
        flashnetState.pending.push({ wallet: this.wallet, resolve })
      })
    }
    async listPools() {
      return []
    }
    async getUserSwaps() {
      return { swaps: [] }
    }
    async cleanup() {}
  }
  return { FlashnetClient: FakeFlashnetClient }
})

import { flashnetClientManager } from '../../src/lib/flashnet-client-manager'

afterEach(async () => {
  await flashnetClientManager.disconnect()
  flashnetState.pending.length = 0
})

describe('FlashnetClientManager wallet-switch race', () => {
  // NOTE: the plain disconnect()-during-init path was CHECKED AND IS SAFE:
  // doInitialize assigns `this.client = new FlashnetClient(wallet)` BEFORE
  // awaiting client.initialize() (flashnet-client-manager.ts:72-73), so a
  // disconnect() mid-init still finds and nulls the client. No resurrection.
  it('F8 [FIXED]: initialize(B) during in-flight initialize(A) rebinds to wallet B', async () => {
    const walletA = { marker: 'SPARK_A', getSparkAddress: async () => 'spark1a' }
    const walletB = { marker: 'SPARK_B', getSparkAddress: async () => 'spark1b' }

    // A's init starts and parks inside the SDK.
    const initA = flashnetClientManager.initialize(walletA as never, 'regtest')
    await vi.waitFor(() => expect(flashnetState.pending).toHaveLength(1))

    // Wallet switch to B while A is in flight. The in-flight promise belongs to
    // wallet A, so it must NOT be handed to B's caller.
    const initB = flashnetClientManager.initialize(walletB as never, 'regtest')
    expect(flashnetState.pending).toHaveLength(2) // B's client was constructed too

    // A's SDK init lands after the switch — the superseded client is discarded.
    flashnetState.pending[0].resolve()
    flashnetState.pending[1].resolve()
    await Promise.allSettled([initA, initB])

    expect(
      (flashnetClientManager.getClient() as unknown as { wallet: { marker: string } }).wallet
        .marker,
    ).toBe('SPARK_B')
  })

  it('F8b [FIXED]: a disconnect() during in-flight init does not install the client afterwards', async () => {
    const walletA = { marker: 'SPARK_A', getSparkAddress: async () => 'spark1a' }

    const initA = flashnetClientManager.initialize(walletA as never, 'regtest')
    await vi.waitFor(() => expect(flashnetState.pending).toHaveLength(1))

    await flashnetClientManager.disconnect()
    expect(flashnetClientManager.isInitialized()).toBe(false)

    flashnetState.pending[0].resolve()
    await initA.catch(() => {})

    expect(flashnetClientManager.isInitialized()).toBe(false)
    expect(flashnetClientManager.getNetwork()).toBeNull()
  })
})
