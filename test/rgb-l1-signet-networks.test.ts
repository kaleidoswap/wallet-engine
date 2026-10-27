import { describe, it, expect } from 'vitest'
import { RgbLibWasmAdapter } from '../src/adapters/wdk/RgbLibWasmAdapter'
import { registerWdkModule } from '../src/adapters/wdk/moduleLoader'
import { BIP39_TEST_VECTOR_MNEMONIC } from './fixtures/mnemonics'

async function connectAs(network: string) {
  const seen: { keys?: string; dataDir?: unknown } = {}
  registerWdkModule('@utexo/rgb-lib-wasm', () => ({
    init: () => {},
    restoreKeys: (net: string) => {
      seen.keys = net
      return { mnemonic: 'm', masterFingerprint: 'fp', accountXpubVanilla: 'xpub1', accountXpubColored: 'xpub2' }
    },
    WasmWallet: {
      create: async (json: string) => {
        seen.dataDir = JSON.parse(json).dataDir
        return { goOnline: async () => 'online' }
      },
    },
  }))
  await new RgbLibWasmAdapter()
    .connect({ protocol: 'RGB_L1', network, mnemonic: BIP39_TEST_VECTOR_MNEMONIC, indexerUrl: 'http://indexer' } as any)
    .catch(() => undefined)
  return seen
}

describe('RGB on-chain: signet vs custom signet', () => {
  it("'signet' is the default public signet", async () => {
    expect((await connectAs('signet')).keys).toBe('Signet')
  })

  it.each(['mutinynet', 'signetcustom', 'customsignet'])("'%s' is a custom signet", async (network) => {
    expect((await connectAs(network)).keys).toBe('SignetCustom')
  })

  it('keeps Mutinynet data apart from signet data', async () => {
    expect((await connectAs('mutinynet')).dataDir).toBe('rgb-l1-signetcustom')
    expect((await connectAs('signet')).dataDir).toBe('rgb-l1-signet')
  })
})
