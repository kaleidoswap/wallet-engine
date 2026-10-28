import { describe, it, expect, beforeEach } from 'vitest'
import { BoltzChainSwap, witnessRevealsPreimage } from '../src/swap/BoltzChainSwap'
import { BoltzChainSwapStore, encode, type BoltzChainSwapRecord } from '../src/swap/boltz-swap-store'
import { boltzSwapClientManager } from '../src/lib/boltz-swap-client-manager'
import type {
  ChainKind,
  ChainOutspend,
  ChainTransaction,
  IChainDataProvider,
  IStorageProvider,
} from '../src/ports'

/**
 * Security review 2026-10-28, finding 12: maker status strings and the maker's
 * `height()` used to be the only evidence behind a claim. A claim reveals the
 * preimage, so a lying maker could have a victim claim against an unconfirmed,
 * replaceable lockup. Every claim decision now rests on the trusted chain-data
 * provider; the maker's word is a hint at most.
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

/** In-memory chain: per-chain tip, transactions and outspends. */
class FakeChain implements IChainDataProvider {
  tips: Record<ChainKind, number> = { bitcoin: 800, liquid: 900 }
  txs = new Map<string, ChainTransaction>()
  outspends = new Map<string, ChainOutspend>()
  calls: string[] = []
  async tipHeight(chain: ChainKind) {
    this.calls.push(`tip:${chain}`)
    return this.tips[chain]
  }
  async getTransaction(chain: ChainKind, txid: string) {
    this.calls.push(`tx:${chain}:${txid}`)
    return this.txs.get(`${chain}:${txid}`) ?? null
  }
  async getOutspend(chain: ChainKind, txid: string, vout: number) {
    this.calls.push(`outspend:${chain}:${txid}:${vout}`)
    return this.outspends.get(`${chain}:${txid}:${vout}`) ?? { spent: false }
  }
}

const KEY = { publicKey: '02'.padEnd(66, 'a'), secretKey: 'ff'.padEnd(64, '0') }
const PREIMAGE = { preimage: 'aa'.repeat(32), sha256: 'bb'.repeat(32), hash160: 'cc'.repeat(20) }

// Liquid regtest confidential taproot address (elements test vector) and the
// script it commits to; Bitcoin taproot address from BIP-350 and its script.
const LIQUID_LOCKUP =
  'el1pqgft7r4ytdenml0gaj67393sd3qkt3nxex0ut5dt3plhzwf6jaww5wpq7p3x4f75f5gch3gktgxxwu2rxm394tsw8dchxedsc6r53w75cj24fq2u2ls5'
const LIQUID_SCRIPT = '51203820f0626aa7d44d118bc5165a0c67714336e25aae0e3b717365b0c68748bbd4'
const BTC_LOCKUP = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'
const BTC_SCRIPT = '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

const SERVER_TXID = '11'.repeat(32)
const USER_TXID = '22'.repeat(32)
const SPEND_TXID = '33'.repeat(32)

const RESPONSE = encode({
  id: 'swap-1',
  lockupDetails: { lockupAddress: BTC_LOCKUP, amount: 100_000n, timeoutBlockHeight: 1000n },
  claimDetails: { lockupAddress: LIQUID_LOCKUP, amount: 99_000n, timeoutBlockHeight: 5000n },
})

const BASE: BoltzChainSwapRecord = {
  swapId: 'swap-1',
  index: 0,
  from: 'BTC',
  to: 'L-BTC',
  userLockAmount: 100_000,
  serverLockAmount: 99_000,
  claimTimeoutBlockHeight: 5000,
  lockupAddress: BTC_LOCKUP,
  destinationAddress: 'el1qdestination',
  lockupTxid: USER_TXID,
  phase: 'server_locked',
  createdAt: 1,
  updatedAt: 1,
  response: RESPONSE,
}

function serverLockupTx(opts: { blockHeight?: number; valueSat?: number | null; script?: string } = {}): ChainTransaction {
  const out: ChainTransaction['vout'][number] = { scriptPubKey: opts.script ?? LIQUID_SCRIPT }
  if (opts.valueSat !== null) out.valueSat = opts.valueSat ?? 99_000
  const tx: ChainTransaction = {
    txid: SERVER_TXID,
    hex: 'deadbeef',
    vin: [{ txid: '44'.repeat(32), vout: 0, witness: [] }],
    vout: [{ scriptPubKey: '0014' + 'ab'.repeat(20), valueSat: 5 }, out],
  }
  if (opts.blockHeight !== undefined) tx.blockHeight = opts.blockHeight
  return tx
}

interface Captured {
  claims: any[]
  broadcasts: number
}

function installFakeSdk(overrides: Record<string, any> = {}): Captured {
  const captured: Captured = { claims: [], broadcasts: 0 }
  const client = {
    chainPairs: async () => ({}),
    createChainSwap: async () => ({}),
    swap: async () => ({ status: 'transaction.server.confirmed' }),
    chainTxs: async () => ({ serverLock: { transaction: { id: SERVER_TXID } } }),
    // A lying maker: its tip never closes the claim window.
    height: async () => ({ BTC: 100n, 'L-BTC': 100n }),
    ...overrides,
  }
  const manager = boltzSwapClientManager as any
  manager.client = client
  manager.config = { network: 'regtest' }
  manager.sdk = {
    init: async () => undefined,
    SwapClient: {},
    SwapScript: {
      fromChain: () => ({
        constructClaim: async (_preimage: string, params: any) => {
          captured.claims.push(params)
          return {
            broadcast: async () => {
              captured.broadcasts++
              return 'claim-txid'
            },
            hex: () => '',
            txid: () => 'claim-txid',
          }
        },
        constructRefund: async () => ({ broadcast: async () => 'refund-txid', hex: () => '', txid: () => '' }),
      }),
    },
    SwapMasterKey: {
      fromWalletMnemonic: () => ({
        masterXpub: () => 'xpub-master',
        deriveSwapKey: () => KEY,
        derivePreimage: () => PREIMAGE,
      }),
    },
  }
  return captured
}

async function swapWith(
  record: Partial<BoltzChainSwapRecord>,
  config: Partial<ConstructorParameters<typeof BoltzChainSwap>[0]> = {}
) {
  const store = new BoltzChainSwapStore(new MemoryStorage())
  await store.put({ ...BASE, ...record })
  return { store, swap: new BoltzChainSwap({ mnemonic: 'test mnemonic', ...config }, store) }
}

let chain: FakeChain
let sdk: Captured

beforeEach(() => {
  chain = new FakeChain()
  sdk = installFakeSdk()
})

describe('claim: maker lockup verified on chain, not from maker status', () => {
  it('refuses when the maker says confirmed but the chain shows the lockup unconfirmed', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx())
    const { swap, store } = await swapWith({ phase: 'server_locked' }, { chainData: chain })
    await expect(swap.claim('swap-1')).rejects.toMatchObject({ code: 'LOCKUP_UNCONFIRMED' })
    expect(sdk.claims).toHaveLength(0)
    expect(sdk.broadcasts).toBe(0)
    expect((await store.get('swap-1'))?.phase).toBe('server_locked')
  })

  it('refuses when the chain source does not know the lockup at all', async () => {
    const { swap } = await swapWith({ phase: 'server_locked' }, { chainData: chain })
    await expect(swap.claim('swap-1')).rejects.toMatchObject({ code: 'LOCKUP_NOT_FOUND' })
    expect(sdk.claims).toHaveLength(0)
  })

  it('refuses when the named transaction pays a different script', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx({ blockHeight: 890, script: BTC_SCRIPT }))
    const { swap } = await swapWith({ phase: 'server_locked' }, { chainData: chain })
    await expect(swap.claim('swap-1')).rejects.toMatchObject({ code: 'LOCKUP_MISMATCH' })
    expect(sdk.claims).toHaveLength(0)
  })

  it('refuses when the lockup pays less than the agreed amount', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx({ blockHeight: 890, valueSat: 98_999 }))
    const { swap } = await swapWith({ phase: 'server_locked' }, { chainData: chain })
    await expect(swap.claim('swap-1')).rejects.toThrow(/pays 98999 sat, expected 99000 sat/)
    expect(sdk.claims).toHaveLength(0)
  })

  it('refuses when the maker names no lockup transaction', async () => {
    sdk = installFakeSdk({ chainTxs: async () => ({}) })
    const { swap } = await swapWith({ phase: 'server_locked' }, { chainData: chain })
    await expect(swap.claim('swap-1')).rejects.toThrow(/reports no lockup transaction/)
    expect(sdk.claims).toHaveLength(0)
  })

  it('claims once the chain shows enough depth, pinned to the verified transaction', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx({ blockHeight: 900 }))
    const { swap, store } = await swapWith({ phase: 'server_locked' }, { chainData: chain })
    const record = await swap.claim('swap-1')
    expect(record.phase).toBe('claimed')
    expect(record.claimTxid).toBe('claim-txid')
    expect(record.serverLockupTxid).toBe(SERVER_TXID)
    expect(record.serverLockupConfirmations).toBe(1)
    expect(sdk.claims).toHaveLength(1)
    expect(sdk.claims[0]).toMatchObject({
      cooperative: false,
      claimLockup: { chain: 'liquid', hex: 'deadbeef', txid: SERVER_TXID },
    })
    expect((await store.get('swap-1'))?.phase).toBe('claimed')
  })

  it('honours a higher minLockupConfirmations', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx({ blockHeight: 899 }))
    const { swap } = await swapWith({ phase: 'server_locked' }, { chainData: chain, minLockupConfirmations: 3 })
    await expect(swap.claim('swap-1')).rejects.toThrow(/has 2 confirmation\(s\) on liquid, needs 3/)
    chain.tips.liquid = 901
    await expect(swap.claim('swap-1')).resolves.toMatchObject({ phase: 'claimed' })
  })

  it('accepts a blinded Liquid output whose amount the explorer cannot show', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx({ blockHeight: 900, valueSat: null }))
    const { swap } = await swapWith({ phase: 'server_locked' }, { chainData: chain })
    await expect(swap.claim('swap-1')).resolves.toMatchObject({ phase: 'claimed' })
  })

  it('claims from server_locking when the chain is ahead of the maker status', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx({ blockHeight: 900 }))
    const { swap } = await swapWith({ phase: 'server_locking' }, { chainData: chain })
    await expect(swap.claim('swap-1')).resolves.toMatchObject({ phase: 'claimed' })
  })

  it('still refuses before the maker has locked at all', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx({ blockHeight: 900 }))
    const { swap } = await swapWith({ phase: 'lockup_funded' }, { chainData: chain })
    await expect(swap.claim('swap-1')).rejects.toThrow(/not claimable in phase/)
  })

  it('allowZeroConf waives only the depth check', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx())
    const { swap } = await swapWith({ phase: 'server_locked' }, { chainData: chain, allowZeroConf: true })
    await expect(swap.claim('swap-1')).resolves.toMatchObject({ phase: 'claimed' })

    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx({ script: BTC_SCRIPT }))
    const other = await swapWith({ phase: 'server_locked' }, { chainData: chain, allowZeroConf: true })
    await expect(other.swap.claim('swap-1')).rejects.toMatchObject({ code: 'LOCKUP_MISMATCH' })
  })

  it('re-asks the maker when a previously verified lockup vanished from the chain', async () => {
    const replacement = '55'.repeat(32)
    sdk = installFakeSdk({ chainTxs: async () => ({ serverLock: { transaction: { id: replacement } } }) })
    chain.txs.set(`liquid:${replacement}`, { ...serverLockupTx({ blockHeight: 900 }), txid: replacement })
    const { swap } = await swapWith({ phase: 'server_locked', serverLockupTxid: SERVER_TXID }, { chainData: chain })
    const record = await swap.claim('swap-1')
    expect(record.serverLockupTxid).toBe(replacement)
  })
})

describe('claim: timeout evaluated on the trusted tip', () => {
  it('refuses when the trusted tip is inside the margin although the maker reports a low height', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx({ blockHeight: 4000 }))
    chain.tips.liquid = 4995 // within Liquid's 10-block margin of 5000; maker says 100
    const { swap } = await swapWith({ phase: 'server_locked' }, { chainData: chain })
    await expect(swap.claim('swap-1')).rejects.toMatchObject({ code: 'CLAIM_WINDOW_CLOSED' })
    expect(sdk.claims).toHaveLength(0)
  })

  it('ignores a maker height that would close the window when the trusted tip is fine', async () => {
    sdk = installFakeSdk({ height: async () => ({ BTC: 4999n, 'L-BTC': 4999n }) })
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx({ blockHeight: 900 }))
    const { swap } = await swapWith({ phase: 'server_locked' }, { chainData: chain })
    await expect(swap.claim('swap-1')).resolves.toMatchObject({ phase: 'claimed' })
  })

  it('uses the destination chain tip', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx({ blockHeight: 900 }))
    chain.tips.bitcoin = 4999
    const { swap } = await swapWith({ phase: 'server_locked' }, { chainData: chain })
    await expect(swap.claim('swap-1')).resolves.toMatchObject({ phase: 'claimed' })
  })
})

describe('claim: no trusted provider', () => {
  it('fails closed with a clear error', async () => {
    const { swap } = await swapWith({ phase: 'server_locked' })
    await expect(swap.claim('swap-1')).rejects.toMatchObject({ code: 'NO_CHAIN_DATA' })
    await expect(swap.claim('swap-1')).rejects.toThrow(/no trusted chain-data provider serves liquid/)
    expect(sdk.claims).toHaveLength(0)
  })

  it('fails closed when only the other chain has an Esplora URL', async () => {
    const { swap } = await swapWith({ phase: 'server_locked' }, { bitcoinEsploraUrl: 'http://localhost:4002/api' })
    await expect(swap.claim('swap-1')).rejects.toMatchObject({ code: 'NO_CHAIN_DATA' })
  })

  it('builds an Esplora provider from the configured URL', async () => {
    const seen: string[] = []
    const fetchStub = (async (url: string) => {
      seen.push(url)
      return { ok: false, status: 404, body: null } as unknown as Response
    }) as unknown as typeof fetch
    const original = globalThis.fetch
    globalThis.fetch = fetchStub
    try {
      const { swap } = await swapWith({ phase: 'server_locked' }, { liquidEsploraUrl: 'http://localhost:4003/api' })
      await expect(swap.claim('swap-1')).rejects.toMatchObject({ code: 'LOCKUP_NOT_FOUND' })
    } finally {
      globalThis.fetch = original
    }
    expect(seen).toContain(`http://localhost:4003/api/tx/${SERVER_TXID}`)
  })

  it('allowUnverifiedClaims restores the maker-trusting path, explicitly', async () => {
    const { swap } = await swapWith({ phase: 'server_locked' }, { allowUnverifiedClaims: true })
    const record = await swap.claim('swap-1')
    expect(record.phase).toBe('claimed')
    expect(sdk.claims[0]).not.toHaveProperty('claimLockup')

    sdk = installFakeSdk({ height: async () => ({ BTC: 100n, 'L-BTC': 4999n }) })
    const closed = await swapWith({ phase: 'server_locked' }, { allowUnverifiedClaims: true })
    await expect(closed.swap.claim('swap-1')).rejects.toMatchObject({ code: 'CLAIM_WINDOW_CLOSED' })

    const locking = await swapWith({ phase: 'server_locking' }, { allowUnverifiedClaims: true })
    await expect(locking.swap.claim('swap-1')).rejects.toThrow(/unconfirmed/)
  })

  it('the opt-out does not bypass a provider that is configured', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx())
    const { swap } = await swapWith({ phase: 'server_locked' }, { chainData: chain, allowUnverifiedClaims: true })
    await expect(swap.claim('swap-1')).rejects.toMatchObject({ code: 'LOCKUP_UNCONFIRMED' })
  })
})

describe('sync: statuses are hints the chain must back', () => {
  it('holds at server_locking when the maker says confirmed but the chain disagrees', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx())
    const { swap } = await swapWith({ phase: 'server_locking' }, { chainData: chain })
    const record = await swap.sync('swap-1')
    expect(record.status).toBe('transaction.server.confirmed')
    expect(record.phase).toBe('server_locking')
    expect(record.serverLockupTxid).toBeUndefined()
  })

  it('holds at server_locking without a provider', async () => {
    const { swap } = await swapWith({ phase: 'lockup_funded' })
    expect((await swap.sync('swap-1')).phase).toBe('server_locking')
  })

  it('advances to server_locked once the chain confirms the lockup', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx({ blockHeight: 900 }))
    const { swap } = await swapWith({ phase: 'server_locking' }, { chainData: chain })
    const record = await swap.sync('swap-1')
    expect(record.phase).toBe('server_locked')
    expect(record.serverLockupTxid).toBe(SERVER_TXID)
    expect(record.serverLockupConfirmations).toBe(1)
  })

  it('holds the phase when the chain source is unavailable', async () => {
    chain.getTransaction = async () => {
      throw new Error('esplora down')
    }
    const { swap } = await swapWith({ phase: 'server_locking' }, { chainData: chain })
    expect((await swap.sync('swap-1')).phase).toBe('server_locking')
  })

  it('does not re-verify a lockup already verified', async () => {
    const { swap } = await swapWith({ phase: 'server_locked', serverLockupTxid: SERVER_TXID }, { chainData: chain })
    expect((await swap.sync('swap-1')).phase).toBe('server_locked')
    expect(chain.calls).toEqual([])
  })
})

describe('sync: userLockupSpent needs an observed preimage spend', () => {
  const userLockupTx: ChainTransaction = {
    txid: USER_TXID,
    hex: '00',
    vin: [],
    vout: [{ scriptPubKey: BTC_SCRIPT, valueSat: 100_000 }],
    blockHeight: 790,
  }
  function spendTx(witness: string[]): ChainTransaction {
    return {
      txid: SPEND_TXID,
      hex: '00',
      vin: [{ txid: USER_TXID, vout: 0, witness }],
      vout: [{ scriptPubKey: '0014' + 'cd'.repeat(20), valueSat: 99_000 }],
    }
  }

  it('stays false on transaction.claimed with no on-chain spend', async () => {
    sdk = installFakeSdk({ swap: async () => ({ status: 'transaction.claimed' }) })
    chain.txs.set(`bitcoin:${USER_TXID}`, userLockupTx)
    const { swap } = await swapWith({ phase: 'server_locked' }, { chainData: chain })
    const record = await swap.sync('swap-1')
    expect(record.status).toBe('transaction.claimed')
    expect(record.userLockupSpent).toBeFalsy()
  })

  it('stays false without a provider', async () => {
    sdk = installFakeSdk({ swap: async () => ({ status: 'transaction.claimed' }) })
    const { swap } = await swapWith({ phase: 'server_locked' })
    expect((await swap.sync('swap-1')).userLockupSpent).toBeFalsy()
  })

  it('stays false when the spend carries no preimage (our own refund)', async () => {
    sdk = installFakeSdk({ swap: async () => ({ status: 'transaction.claimed' }) })
    chain.txs.set(`bitcoin:${USER_TXID}`, userLockupTx)
    chain.outspends.set(`bitcoin:${USER_TXID}:0`, { spent: true, txid: SPEND_TXID, vin: 0 })
    chain.txs.set(`bitcoin:${SPEND_TXID}`, spendTx(['ab'.repeat(64), '01']))
    const { swap } = await swapWith({ phase: 'server_locked' }, { chainData: chain })
    expect((await swap.sync('swap-1')).userLockupSpent).toBeFalsy()
  })

  it('is set once the spend reveals the preimage, and the record keeps it', async () => {
    sdk = installFakeSdk({ swap: async () => ({ status: 'transaction.claimed' }) })
    chain.txs.set(`bitcoin:${USER_TXID}`, userLockupTx)
    chain.outspends.set(`bitcoin:${USER_TXID}:0`, { spent: true, txid: SPEND_TXID, vin: 0 })
    chain.txs.set(`bitcoin:${SPEND_TXID}`, spendTx(['ab'.repeat(64), PREIMAGE.preimage.toUpperCase(), 'c0ffee']))
    const { swap, store } = await swapWith({ phase: 'server_locked' }, { chainData: chain })
    expect((await swap.sync('swap-1')).userLockupSpent).toBe(true)

    sdk = installFakeSdk({ swap: async () => ({ status: 'swap.expired' }) })
    expect((await swap.sync('swap-1')).userLockupSpent).toBe(true)
    expect((await store.get('swap-1'))?.userLockupSpent).toBe(true)
  })

  it('is not probed on statuses other than transaction.claimed', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx({ blockHeight: 900 }))
    const { swap } = await swapWith({ phase: 'server_locked', serverLockupTxid: SERVER_TXID }, { chainData: chain })
    await swap.sync('swap-1')
    expect(chain.calls.filter((c) => c.startsWith('outspend'))).toEqual([])
  })

  it('witnessRevealsPreimage matches the stack item exactly', () => {
    const tx = spendTx(['00' + PREIMAGE.preimage, PREIMAGE.preimage])
    expect(witnessRevealsPreimage(tx, 0, PREIMAGE.preimage)).toBe(true)
    expect(witnessRevealsPreimage(spendTx(['00' + PREIMAGE.preimage]), 0, PREIMAGE.preimage)).toBe(false)
    expect(witnessRevealsPreimage(tx, 1, PREIMAGE.preimage)).toBe(false)
  })
})

describe('claim after userLockupSpent', () => {
  it('skips depth and timeout but still pins the located lockup', async () => {
    chain.txs.set(`liquid:${SERVER_TXID}`, serverLockupTx())
    chain.tips.liquid = 4999
    const { swap } = await swapWith({ phase: 'server_locking', userLockupSpent: true }, { chainData: chain })
    const record = await swap.claim('swap-1')
    expect(record.phase).toBe('claimed')
    expect(sdk.claims[0]).toMatchObject({ claimLockup: { txid: SERVER_TXID } })
  })

  it('claims unpinned without a provider — the secret is already public', async () => {
    const { swap } = await swapWith({ phase: 'server_locking', userLockupSpent: true })
    await expect(swap.claim('swap-1')).resolves.toMatchObject({ phase: 'claimed' })
    expect(sdk.claims[0]).not.toHaveProperty('claimLockup')
  })
})

describe('config validation', () => {
  it('rejects a non-positive minLockupConfirmations', () => {
    const store = new BoltzChainSwapStore(new MemoryStorage())
    expect(() => new BoltzChainSwap({ mnemonic: 'm', minLockupConfirmations: 0 }, store)).toThrow(/positive integer/)
    expect(() => new BoltzChainSwap({ mnemonic: 'm', minLockupConfirmations: 1.5 }, store)).toThrow(/positive integer/)
  })
})
