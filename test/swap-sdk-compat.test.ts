import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { registerWdkModule } from '../src/adapters/wdk/moduleLoader'
import {
  boltzSwapClientManager,
  makerBaseUrlParam,
  resolveSwapClientCtor,
  usesMakerVocabulary,
  type BoltzSdkModule,
} from '../src/lib/boltz-swap-client-manager'
import { BoltzChainSwap } from '../src/swap/BoltzChainSwap'
import { BoltzChainSwapStore, encode } from '../src/swap/boltz-swap-store'
import type { IStorageProvider } from '../src/ports'

/**
 * `@kaleidorg/swap-sdk` 0.9.0 renamed `BoltzClient` to `SwapClient` and the
 * claim/refund `boltzBaseUrl` field to `makerBaseUrl`, with no aliases. The
 * engine's peer range spans both sides of that rename (0.7.x and 0.10.x), so
 * each SDK shape must get the constructor and the field name it understands.
 */

const PACKAGE = '@kaleidorg/swap-sdk'
const MAKER = 'http://maker.test/v2'

class MemoryStorage implements IStorageProvider {
  private map = new Map<string, string>()
  async get(key: string) {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string) {
    this.map.set(key, value)
  }
  async remove(key: string) {
    this.map.delete(key)
  }
  async keys() {
    return [...this.map.keys()]
  }
}

/** A fake client constructor recording how it was built. */
function fakeCtor(label: string) {
  const calls: unknown[][] = []
  class FakeClient {
    readonly label = label
    readonly args: unknown[]
    constructor(...args: unknown[]) {
      this.args = args
      calls.push(['new', ...args])
    }
    static forNetwork(network: string) {
      calls.push(['forNetwork', network])
      return new FakeClient(`default:${network}`)
    }
    chainPairs = async () => ({})
    createChainSwap = async () => ({})
    swap = async () => ({})
    chainTxs = async () => ({})
    height = async () => ({})
  }
  return { ctor: FakeClient as any, calls }
}

/** Module shape of swap-sdk 0.9.0 and later. */
function modernSdk(extra: Partial<BoltzSdkModule> = {}): BoltzSdkModule {
  return {
    init: async () => undefined,
    SwapClient: fakeCtor('SwapClient').ctor,
    SwapScript: { fromChain: () => ({}) as any },
    SwapMasterKey: { fromWalletMnemonic: () => ({}) as any },
    ...extra,
  }
}

/** Module shape of swap-sdk 0.7.x and earlier. */
function legacySdk(extra: Partial<BoltzSdkModule> = {}): BoltzSdkModule {
  return {
    init: async () => undefined,
    BoltzClient: fakeCtor('BoltzClient').ctor,
    SwapScript: { fromChain: () => ({}) as any },
    SwapMasterKey: { fromWalletMnemonic: () => ({}) as any },
    ...extra,
  }
}

beforeEach(() => {
  boltzSwapClientManager.dispose()
})

afterEach(() => {
  boltzSwapClientManager.dispose()
})

describe('client constructor resolution', () => {
  it('uses SwapClient on swap-sdk >= 0.9', () => {
    const mod = modernSdk()
    expect(resolveSwapClientCtor(mod)).toBe(mod.SwapClient)
    expect(usesMakerVocabulary(mod)).toBe(true)
  })

  it('falls back to BoltzClient on swap-sdk 0.7', () => {
    const mod = legacySdk()
    expect(resolveSwapClientCtor(mod)).toBe(mod.BoltzClient)
    expect(usesMakerVocabulary(mod)).toBe(false)
  })

  it('prefers SwapClient when a module exports both names', () => {
    const mod = legacySdk({ SwapClient: fakeCtor('SwapClient').ctor })
    expect(resolveSwapClientCtor(mod)).toBe(mod.SwapClient)
  })

  it('names the problem when the module exports neither', () => {
    const mod = { init: async () => undefined } as unknown as BoltzSdkModule
    expect(() => resolveSwapClientCtor(mod)).toThrow(/neither SwapClient nor BoltzClient/)
  })
})

describe('claim/refund maker URL field', () => {
  it('sends makerBaseUrl, and only that, to swap-sdk >= 0.9', () => {
    expect(makerBaseUrlParam(modernSdk(), MAKER)).toEqual({ makerBaseUrl: MAKER })
  })

  it('sends boltzBaseUrl, and only that, to swap-sdk 0.7', () => {
    expect(makerBaseUrlParam(legacySdk(), MAKER)).toEqual({ boltzBaseUrl: MAKER })
  })
})

describe('manager initialization', () => {
  for (const [name, make, label] of [
    ['0.10 (SwapClient)', modernSdk, 'SwapClient'],
    ['0.7 (BoltzClient)', legacySdk, 'BoltzClient'],
  ] as const) {
    it(`builds an explicit-URL client from swap-sdk ${name}`, async () => {
      registerWdkModule(PACKAGE, () => make())
      await boltzSwapClientManager.initialize({ network: 'regtest', baseUrl: MAKER, timeoutSecs: 7 })
      const client = boltzSwapClientManager.getClient() as any
      expect(client.label).toBe(label)
      expect(client.args).toEqual([MAKER, 7n])
    })

    it(`builds the network-default client from swap-sdk ${name}`, async () => {
      registerWdkModule(PACKAGE, () => make())
      await boltzSwapClientManager.initialize({ network: 'signet' })
      expect((boltzSwapClientManager.getClient() as any).args).toEqual(['default:signet'])
    })
  }

  it('fails initialization on a module with no client export', async () => {
    registerWdkModule(PACKAGE, () => ({ init: async () => undefined }))
    await expect(boltzSwapClientManager.initialize({ network: 'regtest' })).rejects.toThrow(
      /neither SwapClient nor BoltzClient/
    )
    expect(boltzSwapClientManager.isInitialized()).toBe(false)
  })
})

describe('chain swap claim/refund params per SDK version', () => {
  const RECORD = {
    swapId: 'swap-1',
    index: 0,
    from: 'BTC' as const,
    to: 'L-BTC' as const,
    userLockAmount: 100_000,
    serverLockAmount: 99_000,
    claimTimeoutBlockHeight: 5000,
    lockupAddress: 'bcrt1qlockup',
    destinationAddress: 'el1qdestination',
    lockupTxid: 'funding-txid',
    userLockupSpent: true,
    createdAt: 1,
    updatedAt: 1,
    response: encode({ lockupDetails: {}, claimDetails: {} }),
  }

  async function run(make: (extra?: Partial<BoltzSdkModule>) => BoltzSdkModule) {
    const seen: { claim?: Record<string, unknown>; refund?: Record<string, unknown> } = {}
    const tx = { broadcast: async () => 'txid', hex: () => '', txid: () => 'txid' }
    const mod = make({
      SwapScript: {
        fromChain: () => ({
          constructClaim: async (_preimage: string, params: any) => {
            seen.claim = params
            return tx
          },
          constructRefund: async (params: any) => {
            seen.refund = params
            return tx
          },
        }),
      },
      SwapMasterKey: {
        fromWalletMnemonic: () => ({
          masterXpub: () => 'xpub',
          deriveSwapKey: () => ({ publicKey: '02'.padEnd(66, 'a'), secretKey: 'ff'.padEnd(64, '0') }),
          derivePreimage: () => ({ preimage: 'aa'.repeat(32), sha256: 'bb'.repeat(32), hash160: 'cc'.repeat(20) }),
        }),
      },
    })
    registerWdkModule(PACKAGE, () => mod)
    await boltzSwapClientManager.initialize({ network: 'regtest', baseUrl: MAKER })

    const store = new BoltzChainSwapStore(new MemoryStorage())
    await store.put({ ...RECORD, phase: 'server_locked' } as any)
    await store.put({ ...RECORD, swapId: 'swap-2', phase: 'refundable' } as any)
    const swap = new BoltzChainSwap({ mnemonic: 'test mnemonic' }, store)
    await swap.claim('swap-1')
    await swap.refund('swap-2')
    return seen
  }

  it('passes makerBaseUrl to claim and refund on swap-sdk >= 0.9', async () => {
    const seen = await run(modernSdk)
    for (const params of [seen.claim, seen.refund]) {
      expect(params).toMatchObject({ makerBaseUrl: MAKER, network: 'regtest' })
      expect(params).not.toHaveProperty('boltzBaseUrl')
    }
  })

  it('passes boltzBaseUrl to claim and refund on swap-sdk 0.7', async () => {
    const seen = await run(legacySdk)
    for (const params of [seen.claim, seen.refund]) {
      expect(params).toMatchObject({ boltzBaseUrl: MAKER, network: 'regtest' })
      expect(params).not.toHaveProperty('makerBaseUrl')
    }
  })
})

describe('installed swap-sdk', () => {
  it('is detected as the maker vocabulary and resolves its client', async () => {
    const mod = (await import(PACKAGE)) as unknown as BoltzSdkModule
    const { version } = (await import(`${PACKAGE}/package.json`, { with: { type: 'json' } })).default
    const modern = Number(version.split('.')[1]) >= 9
    expect(usesMakerVocabulary(mod)).toBe(modern)
    expect(resolveSwapClientCtor(mod)).toBe(modern ? mod.SwapClient : mod.BoltzClient)
  })
})
