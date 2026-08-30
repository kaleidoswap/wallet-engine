import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Audit finding A7 — `ArkadeSwapsClientManager.initialize()` opened with
 * `if (this.client) return Promise.resolve()`, with no comparison of WHICH wallet
 * the existing client was built for. Its generation machinery guards only the
 * in-flight case, not the already-built one.
 *
 * `ProtocolManager.connect()` calls `adapter.connect(config)` directly and never
 * `adapter.disconnect()` (ProtocolManager.ts:268), and `dispose()` is only reached
 * from `ArkadeAdapter.disconnect()` (ArkadeAdapter.ts:141). So a wallet switch
 * left the Boltz swaps client bound to the PREVIOUS wallet's keys, and every swap
 * in the new session signed and spent the previous wallet's VTXOs. Deterministic —
 * no race required.
 */
const created: any[] = []
vi.mock('@arkade-os/boltz-swap', () => ({
  ArkadeSwaps: {
    create: vi.fn(async ({ wallet }: any) => {
      const c = { boundWallet: wallet, dispose: async () => {} }
      created.push(c)
      return c
    }),
  },
  IndexedDbSwapRepository: class {},
}))

const walletA: any = { marker: 'ARK_WALLET_A' }
const walletB: any = { marker: 'ARK_WALLET_B' }

let mgr: typeof import('../../src/lib/arkade-swaps-client-manager').arkadeSwapsClientManager
beforeEach(async () => {
  created.length = 0
  vi.resetModules()
  mgr = (await import('../../src/lib/arkade-swaps-client-manager')).arkadeSwapsClientManager
})
afterEach(async () => { await mgr.dispose() })

const opts = { swapRepository: {} }

describe('A7: the swaps client must follow the active wallet', () => {
  it('initialize(B) after initialize(A) rebinds to B', async () => {
    await mgr.initialize(walletA, opts)
    expect((mgr.getClient() as any).boundWallet.marker).toBe('ARK_WALLET_A')

    await mgr.initialize(walletB, opts)
    expect(
      (mgr.getClient() as any).boundWallet.marker,
      'a swap in wallet B\'s session must not sign with wallet A\'s keys',
    ).toBe('ARK_WALLET_B')
    expect(created.length, 'a new client is built for the new wallet').toBe(2)
  })

  it('re-initialising with the SAME wallet does not rebuild the client', async () => {
    await mgr.initialize(walletA, opts)
    const first = mgr.getClient()
    await mgr.initialize(walletA, opts)
    expect(mgr.getClient()).toBe(first)
    expect(created.length).toBe(1)
  })

  it('the superseded client is disposed, not leaked', async () => {
    let disposed = false
    await mgr.initialize(walletA, opts)
    ;(mgr.getClient() as any).dispose = async () => { disposed = true }
    await mgr.initialize(walletB, opts)
    expect(disposed, 'wallet A\'s swap manager must be stopped').toBe(true)
  })

  it('dispose() still clears everything', async () => {
    await mgr.initialize(walletA, opts)
    await mgr.dispose()
    expect(mgr.isInitialized()).toBe(false)
    expect(() => mgr.getClient()).toThrow()
  })
})
