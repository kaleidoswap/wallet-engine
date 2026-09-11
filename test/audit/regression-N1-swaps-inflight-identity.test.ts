/**
 * AUDIT N1 (run 2, Phase 3 concurrency) — the A7 fix does not survive a wallet
 * switch that RACES the initial Boltz handshake.
 *
 * `ArkadeSwapsClientManager.initialize()` tears down a client bound to a
 * different wallet — but only when the client is already BUILT. While
 * `ArkadeSwaps.create()` is still in flight `this.client` is null, so the
 * wallet-switch branch is skipped and the in-flight promise is returned to
 * wallet B's caller with no identity check. Wallet A's client then installs and
 * `getClient()` serves it for the rest of wallet B's session — the exact harm
 * A7 was fixed for (signing/spending wallet A's VTXOs), restored by a race.
 *
 * The window is the normal case, not an edge case: `ArkadeAdapter.connect()`
 * fires `arkadeSwapsClientManager.initialize(wallet)` WITHOUT awaiting it
 * (src/adapters/ArkadeAdapter.ts:129), so connect() returns while the handshake
 * is still pending.
 *
 * Deterministic: driven by an explicit deferred inside the mocked SDK, not timing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const swapsState = {
  createdWith: [] as unknown[],
  pending: [] as Array<{ wallet: unknown; resolve: (client: unknown) => void }>,
  disposed: [] as unknown[],
}

vi.mock('@arkade-os/boltz-swap', () => {
  class FakeIndexedDbSwapRepository {
    constructor(_dbName: string) {}
  }
  const ArkadeSwaps = {
    create: (opts: { wallet: unknown }) => {
      swapsState.createdWith.push(opts.wallet)
      return new Promise((resolve) => {
        swapsState.pending.push({
          wallet: opts.wallet,
          resolve: () =>
            resolve({
              boundWallet: opts.wallet,
              dispose: async () => {
                swapsState.disposed.push(opts.wallet)
              },
            }),
        })
      })
    },
  }
  return { ArkadeSwaps, IndexedDbSwapRepository: FakeIndexedDbSwapRepository }
})

import { arkadeSwapsClientManager } from '../../src/lib/arkade-swaps-client-manager'

afterEach(async () => {
  await arkadeSwapsClientManager.dispose()
  swapsState.createdWith.length = 0
  swapsState.pending.length = 0
  swapsState.disposed.length = 0
})

describe('N1: ArkadeSwapsClientManager wallet identity across an in-flight handshake', () => {
  it('initialize(walletB) during an in-flight initialize(walletA) must not bind the session to wallet A', async () => {
    const walletA = { marker: 'ARK_WALLET_A' }
    const walletB = { marker: 'ARK_WALLET_B' }

    // Wallet A connects. ArkadeAdapter.connect() does NOT await this.
    const initA = arkadeSwapsClientManager.initialize(walletA as never)
    await vi.waitFor(() => expect(swapsState.pending).toHaveLength(1))

    // Wallet switch lands while A's ArkadeSwaps.create() is still pending.
    const initB = arkadeSwapsClientManager.initialize(walletB as never)

    // Release every handshake that has been started (A's, and B's own if the
    // manager started one). Both `_doInitialize` bodies run synchronously up to
    // `ArkadeSwaps.create()`, so every pending entry already exists here.
    for (const p of swapsState.pending) p.resolve(null)
    await Promise.allSettled([initA, initB])

    // The manager must be bound to wallet B (or hold no client at all) — it must
    // never serve wallet A's swaps client inside wallet B's session.
    if (arkadeSwapsClientManager.isInitialized()) {
      const client = arkadeSwapsClientManager.getClient() as unknown as {
        boundWallet: { marker: string }
      }
      expect(client.boundWallet.marker).toBe('ARK_WALLET_B')
    }
    // And a handshake must actually have been performed for wallet B.
    expect(swapsState.createdWith).toContain(walletB)
  })

  it('the sequential wallet switch (A7) still holds', async () => {
    const walletA = { marker: 'ARK_WALLET_A' }
    const walletB = { marker: 'ARK_WALLET_B' }

    const initA = arkadeSwapsClientManager.initialize(walletA as never)
    await vi.waitFor(() => expect(swapsState.pending).toHaveLength(1))
    swapsState.pending[0].resolve(null)
    await initA

    const initB = arkadeSwapsClientManager.initialize(walletB as never)
    await vi.waitFor(() => expect(swapsState.pending).toHaveLength(2))
    swapsState.pending[1].resolve(null)
    await initB

    const client = arkadeSwapsClientManager.getClient() as unknown as {
      boundWallet: { marker: string }
    }
    expect(client.boundWallet.marker).toBe('ARK_WALLET_B')
  })
})
