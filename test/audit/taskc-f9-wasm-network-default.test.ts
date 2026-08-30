import { describe, it, expect } from 'vitest'
import { RgbLibWasmAdapter } from '../../src/adapters/wdk/RgbLibWasmAdapter'
import { registerWdkModule } from '../../src/adapters/wdk/moduleLoader'

/**
 * AUDIT C-F9 — RgbLibWasmAdapter maps any UNKNOWN network string to 'Mainnet'
 * keys (src/adapters/wdk/RgbLibWasmAdapter.ts:104-105 `default: return 'Mainnet'`).
 *
 * A host typo or a newer network label ('testnet4', 'signet-custom', ...) makes
 * the wallet silently derive MAINNET keys/addresses while the UI reports the
 * requested network — the user believes they are on a valueless network while
 * handing out real mainnet receive addresses.
 */
describe('AUDIT C-F9: toRgbNetwork unknown-network default', () => {
  it("network 'testnet4' must not silently derive mainnet keys", async () => {
    let seenNetwork: string | null = null
    const fakeWallet: any = { goOnline: async () => 'online' }
    registerWdkModule('@utexo/rgb-lib-wasm', () => ({
      init: () => {},
      restoreKeys: (network: string) => {
        seenNetwork = network
        return {
          mnemonic: 'm',
          masterFingerprint: 'fp',
          accountXpubVanilla: 'xpub1',
          accountXpubColored: 'xpub2',
        }
      },
      WasmWallet: { create: async () => fakeWallet },
    }))

    // FIXED (audit finding C-F9): an unrecognised network now fails closed
    // instead of silently deriving mainnet keys.
    const adapter = new RgbLibWasmAdapter()
    await expect(adapter.connect({
      protocol: 'RGB_L1',
      network: 'testnet4',
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      indexerUrl: 'http://indexer',
    } as any)).rejects.toThrow(/Unsupported RGB network/)
    expect(seenNetwork, 'no keys may be derived at all').toBeNull()
    expect(adapter.isConnected()).toBe(false)
  })
})
