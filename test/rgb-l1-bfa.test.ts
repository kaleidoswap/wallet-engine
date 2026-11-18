import { describe, it, expect } from 'vitest'
import { RgbLibWasmAdapter } from '../src/adapters/wdk/RgbLibWasmAdapter'
import { registerWdkModule } from '../src/adapters/wdk/moduleLoader'
import { BIP39_TEST_VECTOR_MNEMONIC } from './fixtures/mnemonics'

const ANVIL = { '31337': { rpcUrl: 'http://127.0.0.1:8545', minMintLockBlocks: 2, maxMintLockBlocks: 100 } }

async function connect(network: string, evmChains: unknown, goOnline: (opts: any) => Promise<unknown>) {
  const seen: { schemas?: string[]; calls: any[] } = { calls: [] }
  registerWdkModule('@utexo/rgb-lib-wasm', () => ({
    init: () => {},
    restoreKeys: () => ({ mnemonic: 'm', masterFingerprint: 'fp', accountXpubVanilla: 'x1', accountXpubColored: 'x2' }),
    WasmWallet: {
      create: async (json: string) => {
        seen.schemas = JSON.parse(json).supportedSchemas
        return {
          goOnline: async (opts: any) => {
            seen.calls.push(opts.evmChains)
            return goOnline(opts)
          },
          getBtcBalance: async () => ({ vanilla: { settled: 1, spendable: 1 } }),
          sync: async () => {},
        }
      },
    },
  }))
  const adapter = new RgbLibWasmAdapter()
  const error = await adapter
    .connect({
      protocol: 'RGB_L1',
      network,
      mnemonic: BIP39_TEST_VECTOR_MNEMONIC,
      indexerUrl: 'http://indexer',
      evmChains,
    } as any)
    .then(() => undefined, (e: unknown) => e)
  return { seen, error }
}

describe('RGB on-chain: BFA', () => {
  it('supports BFA on the test networks only', async () => {
    expect((await connect('regtest', undefined, async () => 'online')).seen.schemas).toEqual(['Nia', 'Ifa', 'Bfa'])
    expect((await connect('mainnet', undefined, async () => 'online')).seen.schemas).toEqual(['Nia'])
  })

  it('passes the EVM chains in the bindings shape, never on mainnet', async () => {
    const { seen } = await connect('regtest', ANVIL, async () => 'online')
    expect(seen.calls).toEqual([ANVIL])
    expect((await connect('mainnet', ANVIL, async () => 'online')).seen.calls).toEqual([{}])
  })

  it('drops EVM chains with an invalid id or lock window', async () => {
    const { seen } = await connect(
      'regtest',
      {
        abc: ANVIL['31337'],
        '1': { rpcUrl: 'http://a', minMintLockBlocks: 10, maxMintLockBlocks: 5 },
        '2': { rpcUrl: '', minMintLockBlocks: 1, maxMintLockBlocks: 5 },
      },
      async () => 'online',
    )
    expect(seen.calls).toEqual([{}])
  })

  it('goes online without EVM chains when their endpoint is unusable', async () => {
    const { seen, error } = await connect('regtest', ANVIL, async (opts) => {
      if (Object.keys(opts.evmChains).length) throw 'Invalid EVM RPC URL: connection refused'
      return 'online'
    })
    expect(error).toBeUndefined()
    expect(seen.calls).toEqual([expect.objectContaining({ '31337': expect.anything() }), {}])
  })

  it('does not retry other go-online failures', async () => {
    const { seen, error } = await connect('regtest', ANVIL, async () => {
      throw 'Data is inconsistent (spent bitcoins with another wallet: ["a:0"]). Please check its integrity.'
    })
    expect(seen.calls).toHaveLength(1)
    expect(error).toMatchObject({ code: 'INCONSISTENT' })
  })

  it('lists BFA assets with the other fungible schemas', async () => {
    const adapter = new RgbLibWasmAdapter()
    Object.assign(adapter as any, {
      connected: true,
      network: 'regtest',
      online: {},
      account: {
        getBtcBalance: () => ({ vanilla: { settled: 0, spendable: 0 } }),
        listAssets: () => ({
          nia: [{ assetId: 'rgb:NIA', ticker: 'N', precision: 0, balance: { spendable: 1 } }],
          ifa: [],
          bfa: [{ assetId: 'rgb:BFA', ticker: 'wUSDT', precision: 6, balance: { spendable: 2_000_000 } }],
        }),
      },
    })
    const assets = await adapter.listAssets()
    expect(assets.map((a) => a.id)).toEqual(['BTC', 'rgb:NIA', 'rgb:BFA'])
    expect(assets.find((a) => a.id === 'rgb:BFA')).toMatchObject({ protocol: 'RGB_L1', precision: 6 })
  })
})
