import { describe, it, expect, beforeEach } from 'vitest'
import { BoltzChainSwap, nextPhase } from '../src/swap/BoltzChainSwap'
import { BoltzChainSwapStore, encode, decode } from '../src/swap/boltz-swap-store'
import { boltzSwapClientManager } from '../src/lib/boltz-swap-client-manager'
import type { IStorageProvider } from '../src/ports'

/**
 * BTC <-> L-BTC chain swaps. The invariants under test are the ones that decide
 * whether a funded swap stays recoverable: exact bigint round-tripping of the
 * create response (it is re-parsed into a swap script), monotonic index
 * allocation (a reused index is rejected by the maker as a duplicate), and a
 * phase machine that never walks a settled swap backwards.
 */

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

const KEY = { publicKey: '02'.padEnd(66, 'a'), secretKey: 'ff'.padEnd(64, '0') }
const PREIMAGE = { preimage: 'aa'.repeat(32), sha256: 'bb'.repeat(32), hash160: 'cc'.repeat(20) }

/** Pair card in the maker's shape: camelCase, 64-bit fields as bigint. */
const PAIR = {
  BTC: {
    'L-BTC': {
      hash: 'pair-hash',
      rate: 1,
      limits: { minimal: 10_000n, maximal: 10_000_000n, maximalZeroConf: 0n },
      fees: { percentage: 0.5, minerFees: { server: 200n, user: { claim: 100n, lockup: 150n } } },
    },
  },
}

function installFakeSdk(overrides: Record<string, any> = {}) {
  const client = {
    chainPairs: async () => PAIR,
    createChainSwap: async (_network: string, req: any) => ({
      id: 'swap-1',
      lockupDetails: { lockupAddress: 'bcrt1qlockup', amount: BigInt(req.userLockAmount) },
      claimDetails: { lockupAddress: 'el1qclaim', amount: 99_000n, timeoutBlockHeight: 5000n },
    }),
    swap: async () => ({ status: 'swap.created' }),
    chainTxs: async () => ({}),
    height: async () => ({ BTC: 800n, 'L-BTC': 900n }),
    ...overrides,
  }
  const manager = boltzSwapClientManager as any
  manager.client = client
  manager.config = { network: 'regtest' }
  manager.sdk = {
    init: async () => undefined,
    BoltzClient: {},
    SwapScript: { fromChain: () => ({}) },
    SwapMasterKey: {
      fromWalletMnemonic: () => ({
        masterXpub: () => 'xpub-master',
        deriveSwapKey: () => KEY,
        derivePreimage: () => PREIMAGE,
      }),
    },
  }
  return client
}

function makeSwap() {
  const store = new BoltzChainSwapStore(new MemoryStorage())
  return new BoltzChainSwap({ mnemonic: 'test mnemonic' }, store)
}

beforeEach(() => {
  installFakeSdk()
})

describe('bigint round-trip', () => {
  it('restores bigints exactly, not as numbers or strings', () => {
    const value = { amount: 9_007_199_254_740_993n, nested: { fee: 1n }, name: 'x' }
    const back = decode(encode(value)) as typeof value
    expect(back.amount).toBe(9_007_199_254_740_993n)
    expect(typeof back.nested.fee).toBe('bigint')
    expect(back.name).toBe('x')
  })

  it('leaves digit-only strings as strings', () => {
    const back = decode(encode({ txid: '12345' })) as { txid: string }
    expect(back.txid).toBe('12345')
  })
})

describe('index allocation', () => {
  it('never hands out the same index twice under concurrency', async () => {
    const store = new BoltzChainSwapStore(new MemoryStorage())
    const indices = await Promise.all(Array.from({ length: 20 }, () => store.nextIndex()))
    expect(new Set(indices).size).toBe(20)
    expect([...indices].sort((a, b) => a - b)).toEqual([...Array(20).keys()])
  })

  it('persists across store instances', async () => {
    const storage = new MemoryStorage()
    expect(await new BoltzChainSwapStore(storage).nextIndex()).toBe(0)
    expect(await new BoltzChainSwapStore(storage).nextIndex()).toBe(1)
  })

  it('refuses a corrupt persisted index rather than reusing 0', async () => {
    const storage = new MemoryStorage()
    await storage.set('boltz:chain:index', 'not-a-number')
    await expect(new BoltzChainSwapStore(storage).nextIndex()).rejects.toThrow(/Corrupt/)
  })
})

describe('getQuote', () => {
  const REQ = {
    fromAsset: 'BTC',
    toAsset: 'L-BTC',
    fromLayer: 'BTC_L1' as const,
    toLayer: 'BTC_LIQUID' as const,
    fromAmount: 100_000,
  }

  it('prices a pair using the maker fee card', async () => {
    const q = await makeSwap().getQuote(REQ)
    // 0.5% of 100_000 = 500, plus 100 + 150 + 200 miner fees.
    expect(q.fee.amount).toBe(950)
    expect(q.toAmount).toBe(99_050)
    expect(q.provider).toBe('kaleidoswap-boltz')
  })

  it('marks the quote as non-binding with expiresAt 0', async () => {
    expect((await makeSwap().getQuote(REQ)).expiresAt).toBe(0)
  })

  it('rejects layers this venue does not serve', async () => {
    await expect(
      makeSwap().getQuote({ ...REQ, fromLayer: 'RGB_LN' as any })
    ).rejects.toThrow(/BTC_L1 and BTC_LIQUID/)
  })

  it('rejects a same-chain swap', async () => {
    await expect(
      makeSwap().getQuote({ ...REQ, toLayer: 'BTC_L1' as any })
    ).rejects.toThrow(/two different chains/)
  })

  it('rejects an amount outside the pair limits', async () => {
    await expect(makeSwap().getQuote({ ...REQ, fromAmount: 500 })).rejects.toThrow(/pair limits/)
  })

  it('rejects an amount the fees would consume entirely', async () => {
    installFakeSdk({
      chainPairs: async () => ({
        BTC: {
          'L-BTC': {
            ...PAIR.BTC['L-BTC'],
            fees: {
              percentage: 0.5,
              minerFees: { server: 200_000n, user: { claim: 100n, lockup: 150n } },
            },
          },
        },
      }),
    })
    await expect(makeSwap().getQuote(REQ)).rejects.toThrow(/exceed the swap amount/)
  })

  it('fails closed on a renamed money field instead of returning NaN', async () => {
    installFakeSdk({
      chainPairs: async () => ({
        BTC: {
          'L-BTC': {
            ...PAIR.BTC['L-BTC'],
            fees: { percentage: 0.5, minerFees: { server: 200n, user: { claimFee: 100n } } },
          },
        },
      }),
    })
    await expect(makeSwap().getQuote(REQ)).rejects.toThrow(/not a finite number/)
  })
})

describe('createSwap', () => {
  const PARAMS = {
    fromLayer: 'BTC_L1' as const,
    toLayer: 'BTC_LIQUID' as const,
    amountSat: 100_000,
    destinationAddress: 'el1qdestination',
  }

  it('persists the record before returning it', async () => {
    const store = new BoltzChainSwapStore(new MemoryStorage())
    const swap = new BoltzChainSwap({ mnemonic: 'test mnemonic' }, store)
    const record = await swap.createSwap(PARAMS)
    expect(record.phase).toBe('created')
    expect(await store.get('swap-1')).toMatchObject({ swapId: 'swap-1', index: 0 })
  })

  it('takes the funding amount from the maker response, not the request', async () => {
    installFakeSdk({
      createChainSwap: async () => ({
        id: 'swap-1',
        lockupDetails: { lockupAddress: 'bcrt1qlockup', amount: 100_500n },
        claimDetails: { lockupAddress: 'el1qclaim', amount: 99_000n, timeoutBlockHeight: 5000n },
      }),
    })
    const record = await makeSwap().createSwap(PARAMS)
    expect(record.userLockAmount).toBe(100_500)
    expect(record.serverLockAmount).toBe(99_000)
    expect(record.lockupAddress).toBe('bcrt1qlockup')
  })

  it('sends the sha256 preimage hash and one key for both sides', async () => {
    let sent: any = null
    installFakeSdk({
      createChainSwap: async (_n: string, req: any) => {
        sent = req
        return {
          id: 'swap-1',
          lockupDetails: { lockupAddress: 'a', amount: 1n },
          claimDetails: { lockupAddress: 'b', amount: 1n, timeoutBlockHeight: 5000n },
        }
      },
    })
    await makeSwap().createSwap(PARAMS)
    expect(sent.preimageHash).toBe(PREIMAGE.sha256)
    expect(sent.claimPublicKey).toBe(KEY.publicKey)
    expect(sent.refundPublicKey).toBe(KEY.publicKey)
    expect(sent.from).toBe('BTC')
    expect(sent.to).toBe('L-BTC')
  })

  it('rejects a response missing the swap id rather than storing a headless record', async () => {
    installFakeSdk({
      createChainSwap: async () => ({
        lockupDetails: { lockupAddress: 'a', amount: 1n },
        claimDetails: { lockupAddress: 'b', amount: 1n },
      }),
    })
    await expect(makeSwap().createSwap(PARAMS)).rejects.toThrow(/missing 'id'/)
  })

  it('rejects a non-integer amount', async () => {
    await expect(makeSwap().createSwap({ ...PARAMS, amountSat: 1.5 })).rejects.toThrow(
      /positive integer/
    )
  })
})

describe('phase machine', () => {
  it('advances an unfunded swap only once the lockup is seen', () => {
    expect(nextPhase('created', 'transaction.mempool')).toBe('lockup_funded')
    expect(nextPhase('created', 'swap.created')).toBe('created')
  })

  it('holds an unconfirmed server lockup short of claimable', () => {
    expect(nextPhase('lockup_funded', 'transaction.server.mempool')).toBe('server_locking')
  })

  it('opens the claim only once the server lockup confirms', () => {
    expect(nextPhase('server_locking', 'transaction.server.confirmed')).toBe('server_locked')
    expect(nextPhase('lockup_funded', 'transaction.server.confirmed')).toBe('server_locked')
  })

  it('does not walk a confirmed server lockup back to unconfirmed', () => {
    expect(nextPhase('server_locked', 'transaction.server.mempool')).toBe('server_locked')
  })

  it('owes a refund when a funded swap fails, but not an unfunded one', () => {
    expect(nextPhase('lockup_funded', 'swap.expired')).toBe('refundable')
    expect(nextPhase('server_locked', 'transaction.failed')).toBe('refundable')
    expect(nextPhase('created', 'swap.expired')).toBe('failed')
  })

  it('never walks a settled swap backwards', () => {
    expect(nextPhase('claimed', 'swap.expired')).toBe('claimed')
    expect(nextPhase('claimed', 'transaction.server.mempool')).toBe('claimed')
    expect(nextPhase('refunded', 'transaction.failed')).toBe('refunded')
  })

  it('does not read the server claiming our lockup as our claim completing', () => {
    expect(nextPhase('server_locked', 'transaction.claimed')).toBe('server_locked')
  })

  it('holds the phase on a status it does not model', () => {
    expect(nextPhase('server_locked', 'transaction.zeroconf.rejected')).toBe('server_locked')
    expect(nextPhase('lockup_funded', undefined)).toBe('lockup_funded')
  })
})

describe('refund guard', () => {
  it('refuses to refund a swap with no recorded lockup', async () => {
    const store = new BoltzChainSwapStore(new MemoryStorage())
    const swap = new BoltzChainSwap({ mnemonic: 'test mnemonic' }, store)
    await swap.createSwap({
      fromLayer: 'BTC_L1',
      toLayer: 'BTC_LIQUID',
      amountSat: 100_000,
      destinationAddress: 'el1qdestination',
    })
    await expect(swap.refund('swap-1')).rejects.toThrow(/nothing to refund/)
  })

  it('rejects an unknown swap id', async () => {
    await expect(makeSwap().claim('nope')).rejects.toThrow(/Unknown chain swap/)
  })
})

describe('claim guards', () => {
  const BASE = {
    index: 0,
    from: 'BTC' as const,
    to: 'L-BTC' as const,
    userLockAmount: 100_000,
    serverLockAmount: 99_000,
    claimTimeoutBlockHeight: 5000,
    lockupAddress: 'bcrt1qlockup',
    destinationAddress: 'el1qdestination',
    createdAt: 1,
    updatedAt: 1,
    response: '{}',
  }

  async function swapWith(record: Partial<typeof BASE> & { phase: any; userLockupSpent?: boolean }) {
    const store = new BoltzChainSwapStore(new MemoryStorage())
    await store.put({ ...BASE, swapId: 'swap-1', ...record } as any)
    return new BoltzChainSwap({ mnemonic: 'test mnemonic' }, store)
  }

  it('refuses to claim against an unconfirmed maker lockup', async () => {
    const swap = await swapWith({ phase: 'server_locking' })
    await expect(swap.claim('swap-1')).rejects.toThrow(/unconfirmed/)
  })

  it('refuses to claim before the maker has locked at all', async () => {
    const swap = await swapWith({ phase: 'lockup_funded' })
    await expect(swap.claim('swap-1')).rejects.toThrow(/not claimable in phase/)
  })

  it('refuses to claim inside the timeout margin', async () => {
    installFakeSdk({ height: async () => ({ BTC: 800n, 'L-BTC': 4995n }) })
    const swap = await swapWith({ phase: 'server_locked' })
    await expect(swap.claim('swap-1')).rejects.toThrow(/Claim window .* has closed/)
  })

  it('uses the destination chain tip, not the source chain tip', async () => {
    // Liquid tip is inside the margin; a Bitcoin-tip comparison would pass.
    installFakeSdk({ height: async () => ({ BTC: 100n, 'L-BTC': 4999n }) })
    const swap = await swapWith({ phase: 'server_locked' })
    await expect(swap.claim('swap-1')).rejects.toThrow(/Claim window/)
  })

  it('applies the Bitcoin margin when claiming on Bitcoin', async () => {
    installFakeSdk({ height: async () => ({ BTC: 4997n, 'L-BTC': 100n }) })
    // tip 4997 vs timeout 5000: inside Liquid's 10-block margin, outside Bitcoin's 2.
    const swap = await swapWith({ phase: 'server_locked', from: 'L-BTC', to: 'BTC' } as any)
    await expect(swap.claim('swap-1')).rejects.toThrow(/Stored response .* no claimDetails/)
  })

  it('bypasses both guards once the maker has spent our lockup', async () => {
    installFakeSdk({ height: async () => ({ BTC: 800n, 'L-BTC': 4999n }) })
    const swap = await swapWith({ phase: 'server_locking', userLockupSpent: true })
    // Guards passed — it now fails further along, on the empty stored response.
    await expect(swap.claim('swap-1')).rejects.toThrow(/Stored response .* no claimDetails/)
  })
})

describe('sync', () => {
  it('records that the maker spent our lockup', async () => {
    installFakeSdk({ swap: async () => ({ status: 'transaction.claimed' }) })
    const store = new BoltzChainSwapStore(new MemoryStorage())
    const swap = new BoltzChainSwap({ mnemonic: 'test mnemonic' }, store)
    await swap.createSwap({
      fromLayer: 'BTC_L1',
      toLayer: 'BTC_LIQUID',
      amountSat: 100_000,
      destinationAddress: 'el1qdestination',
    })
    const updated = await swap.sync('swap-1')
    expect(updated.userLockupSpent).toBe(true)
  })

  it('keeps the flag set once the preimage is out', async () => {
    installFakeSdk({ swap: async () => ({ status: 'swap.created' }) })
    const store = new BoltzChainSwapStore(new MemoryStorage())
    const swap = new BoltzChainSwap({ mnemonic: 'test mnemonic' }, store)
    const created = await swap.createSwap({
      fromLayer: 'BTC_L1',
      toLayer: 'BTC_LIQUID',
      amountSat: 100_000,
      destinationAddress: 'el1qdestination',
    })
    await store.put({ ...created, userLockupSpent: true })
    expect((await swap.sync('swap-1')).userLockupSpent).toBe(true)
  })

  it('captures the claim timeout height from the create response', async () => {
    const store = new BoltzChainSwapStore(new MemoryStorage())
    const swap = new BoltzChainSwap({ mnemonic: 'test mnemonic' }, store)
    const record = await swap.createSwap({
      fromLayer: 'BTC_L1',
      toLayer: 'BTC_LIQUID',
      amountSat: 100_000,
      destinationAddress: 'el1qdestination',
    })
    expect(record.claimTimeoutBlockHeight).toBe(5000)
  })
})

describe('listPending', () => {
  it('lists only swaps that still owe an action', async () => {
    const store = new BoltzChainSwapStore(new MemoryStorage())
    const swap = new BoltzChainSwap({ mnemonic: 'test mnemonic' }, store)
    const base = {
      index: 0,
      from: 'BTC' as const,
      to: 'L-BTC' as const,
      userLockAmount: 1,
      serverLockAmount: 1,
      lockupAddress: 'a',
      destinationAddress: 'b',
      createdAt: 1,
      updatedAt: 1,
      response: '{}',
    }
    await store.put({ ...base, swapId: 'a', phase: 'lockup_funded' })
    await store.put({ ...base, swapId: 'b', phase: 'refundable' })
    await store.put({ ...base, swapId: 'c', phase: 'claimed' })
    await store.put({ ...base, swapId: 'd', phase: 'failed' })
    const pending = await swap.listPending()
    expect(pending.map((r) => r.swapId).sort()).toEqual(['a', 'b'])
  })
})
