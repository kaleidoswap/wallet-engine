/**
 * TASK A audit probes — two cross-wallet identity bugs:
 *
 *  F7: ArkadeSwapsClientManager.initialize() early-returns when a client
 *      already exists, so a wallet switch that re-runs ArkadeAdapter.connect()
 *      (without a dispose in between — ProtocolManager.connect() calls
 *      adapter.connect() directly, never adapter.disconnect()) leaves the
 *      Boltz swaps client bound to the PREVIOUS wallet's keys.
 *
 *  F8: FlashnetClientManager.initialize() reuses an in-flight initPromise
 *      with no wallet-identity check, so a wallet switch (initialize(B)
 *      while initialize(A) is pending) is silently dropped and the Flashnet
 *      client stays bound to wallet A's SparkWallet (and its keys).
 *      (The disconnect-during-init path was checked and is safe: the client
 *      is assigned before the awaited SDK init, so disconnect() nulls it.)
 *
 * Self-contained: both SDKs are module-mocked; no network access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// --- Mock @arkade-os/boltz-swap --------------------------------------------

const swapsState = {
  /** Wallets ArkadeSwaps.create() was called with, in order. */
  createdWith: [] as unknown[],
}

vi.mock('@arkade-os/boltz-swap', () => {
  class FakeIndexedDbSwapRepository {
    constructor(_dbName: string) {}
  }
  const ArkadeSwaps = {
    create: async (opts: { wallet: unknown }) => {
      swapsState.createdWith.push(opts.wallet)
      return {
        boundWallet: opts.wallet,
        dispose: async () => {},
      }
    },
  }
  return { ArkadeSwaps, IndexedDbSwapRepository: FakeIndexedDbSwapRepository }
})

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

import { arkadeSwapsClientManager } from '../../src/lib/arkade-swaps-client-manager'
import { flashnetClientManager } from '../../src/lib/flashnet-client-manager'

afterEach(async () => {
  await arkadeSwapsClientManager.dispose()
  await flashnetClientManager.disconnect()
  swapsState.createdWith.length = 0
  flashnetState.pending.length = 0
})

describe('ArkadeSwapsClientManager wallet-switch identity', () => {
  it('F7 [FIXED]: initialize(walletB) without dispose now rebinds to wallet B', async () => {
    const walletA = { marker: 'ARK_WALLET_A' }
    const walletB = { marker: 'ARK_WALLET_B' }

    // Wallet A connects (ArkadeAdapter.connect line 129 path).
    await arkadeSwapsClientManager.initialize(walletA as never)
    expect(arkadeSwapsClientManager.isInitialized()).toBe(true)

    // Wallet switch: ProtocolManager.connect() -> ArkadeAdapter.connect(cfgB)
    // re-initializes arkadeClientManager internally, then calls
    // arkadeSwapsClientManager.initialize(walletB). adapter.disconnect() (and
    // therefore dispose()) is NEVER called on this path.
    await arkadeSwapsClientManager.initialize(walletB as never)

    // FIXED (audit finding A7): a client bound to a different wallet is torn
    // down and rebuilt, so wallet B's session never signs with wallet A's keys.
    expect(swapsState.createdWith).toHaveLength(2)
    const client = arkadeSwapsClientManager.getClient() as unknown as {
      boundWallet: { marker: string }
    }
    expect(client.boundWallet.marker).toBe('ARK_WALLET_B')
  })
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
