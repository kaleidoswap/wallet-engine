/*
 * OPEN FINDING — reproduction, not yet fixed.
 *
 * `describe.skip` so the branch stays green: these assert the behaviour the
 * contract requires. Remove the `.skip` when the finding is fixed and each
 * becomes its regression test. See REPORT.md section 2.2.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ArkadeWdkAdapter } from '../../src/adapters/wdk/ArkadeWdkAdapter'
import { SparkWdkAdapter } from '../../src/adapters/wdk/SparkWdkAdapter'
import { RlnWdkAdapter } from '../../src/adapters/wdk/RlnWdkAdapter'
import { LiquidWdkAdapter } from '../../src/adapters/wdk/LiquidWdkAdapter'
import { RgbLibWasmAdapter } from '../../src/adapters/wdk/RgbLibWasmAdapter'
import { RgbLibWdkAdapter } from '../../src/adapters/wdk/RgbLibWdkAdapter'
import { ArkadeAdapter } from '../../src/adapters/ArkadeAdapter'
import { SparkAdapter } from '../../src/adapters/SparkAdapter'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'
import { sparkClientManager } from '../../src/lib/spark-client-manager'
import { registerWdkModule } from '../../src/adapters/wdk/moduleLoader'
import { asRgbOperations } from '../../src/adapters/IProtocolAdapter'

/**
 * TASK G — adapter contract conformance gap tests.
 *
 * Convention: each test asserts the CORRECT contract behavior. A FAILING test
 * therefore demonstrates the bug; a passing test documents a cross-adapter
 * divergence. Everything is mocked — no network, no SDKs, no wasm.
 */

afterEach(() => {
  vi.restoreAllMocks()
  kaleidoClientManager.reset()
})

const ARK_ADDR = 'tark1qexampleexampleexampleexampleexampleexampleexampleexample'

function connected<T extends object>(adapter: T, account: any, extra: Record<string, unknown> = {}): T {
  Object.assign(adapter as any, { connected: true, account, ...extra })
  return adapter
}

// ---------------------------------------------------------------------------
describe('G-F1: ArkadeWdkAdapter Ark-transfer send — confirmed with empty txid', () => {
  it('must throw (like its own sendBtcOnchain) when sendTransaction returns no hash', async () => {
    const adapter = connected(new ArkadeWdkAdapter(), {
      sendTransaction: async () => ({}), // sparse SDK response, no throw
    })
    // CORRECT behavior: reject. ACTUAL (bug): resolves
    // { status: 'confirmed', paymentHash: '', txid: '' }.
    await expect(adapter.sendPayment({ invoice: ARK_ADDR, amount: 4_000 } as any)).rejects.toThrow()
  })

  it('contrast: the on-chain path in the SAME file does throw on empty hash', async () => {
    const adapter = connected(new ArkadeWdkAdapter(), { sendTransaction: async () => ({}) })
    await expect(
      adapter.sendBtcOnchain({ address: 'bc1qexampleexampleexampleexampleexampleexample', amount: 9_000 }),
    ).rejects.toThrow(/did not return a transaction id/i)
  })
})

// ---------------------------------------------------------------------------
describe.skip('G-F2: getPaymentStatus must not report a lookup failure as pending', () => {
  it('SparkWdkAdapter: getTransactionReceipt failure must surface, not return pending', async () => {
    const adapter = connected(new SparkWdkAdapter(), {
      getTransactionReceipt: async () => {
        throw new Error('gateway unreachable')
      },
    })
    await expect(adapter.getPaymentStatus('pay-1')).rejects.toThrow()
  })

  it('RlnWdkAdapter: a listPayments failure is indistinguishable from an in-flight payment', async () => {
    const adapter = connected(new RlnWdkAdapter(), {
      listPayments: async () => {
        throw new Error('node down')
      },
    })
    const r = await adapter.getPaymentStatus('hash-of-a-payment-that-failed')
    expect(r.status).not.toBe('pending') // ACTUAL (bug): 'pending'
  })

  it('ArkadeWdkAdapter: receipt lookup failure must surface, not return pending', async () => {
    const adapter = connected(new ArkadeWdkAdapter(), {
      getTransactionReceipt: async () => {
        throw new Error('indexer down')
      },
    })
    await expect(adapter.getPaymentStatus('tx-1')).rejects.toThrow()
  })

  it('ArkadeAdapter (native): a DISCONNECTED adapter must throw NOT_CONNECTED, not report pending', async () => {
    const adapter = new ArkadeAdapter() // never connected
    expect(adapter.isConnected()).toBe(false)
    await expect(adapter.getPaymentStatus('any-hash')).rejects.toThrow() // ACTUAL (bug): {status:'pending'}
  })
})

// ---------------------------------------------------------------------------
describe.skip('G-F3: SparkAdapter.getInvoiceStatus must not map RPC failure to Pending', () => {
  it('a throwing gateway must surface as an error', async () => {
    vi.spyOn(sparkClientManager, 'isInitialized').mockReturnValue(true)
    vi.spyOn(sparkClientManager, 'getWallet').mockReturnValue({
      getLightningReceiveRequest: async () => {
        throw new Error('gateway 500')
      },
    } as any)
    const adapter = new SparkAdapter()
    ;(adapter as any).invoiceRequestIds.set('lnbc1xyz', 'req-1')
    await expect(adapter.getInvoiceStatus({ invoice: 'lnbc1xyz' })).rejects.toThrow()
    // ACTUAL (bug): resolves { status: 'Pending' }
  })
})

// ---------------------------------------------------------------------------
describe.skip('G-F4: RgbLibWasmAdapter.getBtcBalance must exclude RGB-colored sats (C-F2 residual)', () => {
  it('reports vanilla-only, per the policy fixed in RgbAdapter (f35b3c4)', async () => {
    const adapter = connected(new RgbLibWasmAdapter(), {
      getBtcBalance: async () => ({
        vanilla: { settled: 2500, spendable: 2400, future: 2700 },
        colored: { settled: 800, spendable: 700, future: 900 },
      }),
    })
    const b = await adapter.getBtcBalance()
    // CORRECT (per f35b3c4 policy): total 2400. ACTUAL (bug): 3100 (colored summed in).
    expect(b.total).toBe(2400)
    expect(b.confirmed).toBe(2500)
  })
})

// ---------------------------------------------------------------------------
describe.skip('G-F5: Spark sendAsset must not return a SATS transfer id for a token send', () => {
  it('SparkWdkAdapter: token send with only a sats success entry must throw', async () => {
    const wallet = {
      getSparkAddress: async () => 'spark1sender',
      fulfillSparkInvoice: async () => ({
        tokenTransactionErrors: [],
        invalidInvoices: [],
        tokenTransactionSuccess: [], // no token leg succeeded
        satsTransactionSuccess: [{ transferResponse: { id: 'sats-transfer-id' } }],
      }),
    }
    const adapter = connected(new SparkWdkAdapter(), { _wallet: wallet }, {
      sdk: {
        isValidSparkAddress: () => true,
        getNetworkFromSparkAddress: () => 'MAINNET',
        decodeSparkAddress: () => ({ sparkInvoiceFields: { version: 1 } }),
      },
    } as any)
    // CORRECT: throw — no token transfer happened. ACTUAL (bug): resolves
    // { txId: 'sats-transfer-id' } and skips saveSentTokenRecord.
    await expect(
      adapter.sendAsset({ assetId: 'btkn1token', amount: 100, recipientId: 'spark1invoice' }),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
describe.skip('G-F6: RgbAdapter must not move funds after a FAILED connect()', () => {
  it('sendPayment on a never-successfully-connected adapter must throw NOT_CONNECTED', async () => {
    vi.spyOn(kaleidoClientManager, 'getClient').mockReturnValue({
      rln: {
        getNodeInfo: async () => {
          throw new Error('401 unauthorized')
        },
        sendPayment: async () => ({ payment_hash: 'h', status: 'SUCCEEDED', amount_msat: 1000 }),
      },
      maker: { listAssets: async () => [] },
    } as any)

    const adapter = new RgbAdapter()
    await expect(
      adapter.connect({ protocol: 'RGB_LN', network: 'regtest', nodeUrl: 'http://node:3001' } as any),
    ).rejects.toThrow(/failed to connect/i)
    expect(adapter.isConnected()).toBe(false)

    // CORRECT: NOT_CONNECTED. ACTUAL (bug): the hasNode() guard passes (manager
    // stayed initialized) and the payment goes through.
    await expect(adapter.sendPayment({ invoice: 'lnbc1something' } as any)).rejects.toThrow(/not connected/i)
  })
})

// ---------------------------------------------------------------------------
describe.skip('G-F7: capabilities flags must match what the adapter actually does', () => {
  it('a) LIQUID declares liquid-pset-sign but signLiquidPset throws NOT_SUPPORTED on a plain account', async () => {
    const adapter = connected(new LiquidWdkAdapter(), { getBalance: async () => 0n })
    expect(adapter.capabilities).toContain('liquid-pset-sign') // the static flag
    await expect(adapter.signLiquidPset({ pset: 'AAAA' } as any)).rejects.toThrow(/NOT_SUPPORTED|Simplicity/i)
  })

  it('b) ARKADE declares lightning-receive but createInvoice({layer:BTC_LN}) returns an Ark address', async () => {
    const adapter = connected(new ArkadeWdkAdapter(), { getAddress: async () => ARK_ADDR })
    expect(adapter.capabilities).toContain('lightning-receive')
    const inv = await adapter.createInvoice({ amount: 1000, layer: 'BTC_LN' } as any)
    expect(inv.invoice).toBe(ARK_ADDR) // NOT a bolt11 — the divergence, documented
    expect(inv.paymentHash).toBe('')
  })

  it('c) SPARK declares asset-receive but getReceiveAddress(tokenId) throws UNSUPPORTED_ASSET', async () => {
    const adapter = connected(new SparkWdkAdapter(), {})
    expect(adapter.capabilities).toContain('asset-receive')
    await expect(adapter.getReceiveAddress('btkn1sometoken')).rejects.toThrow(/UNSUPPORTED_ASSET|only supports BTC/i)
  })
})

// ---------------------------------------------------------------------------
describe.skip('G-F8: listTransactions must honor the TransactionFilter contract', () => {
  it('RlnWdkAdapter applies limit', async () => {
    const txs = [1, 2, 3].map((i) => ({ txid: `t${i}`, transaction_type: 'User', received: 100 }))
    const adapter = connected(new RlnWdkAdapter(), { listTransactions: async () => ({ transactions: txs }) })
    const r = await adapter.listTransactions({ limit: 1 })
    expect(r).toHaveLength(1) // ACTUAL (bug): 3 — _filter ignored (RlnWdkAdapter.ts:366)
  })

  it('ArkadeWdkAdapter applies limit', async () => {
    const history = [1, 2, 3].map((i) => ({ key: { arkTxid: `a${i}` }, type: 'RECEIVED', amount: 100, settled: true, createdAt: i * 1000 }))
    const adapter = connected(new ArkadeWdkAdapter(), { getTransactionHistory: async () => history })
    const r = await adapter.listTransactions({ limit: 1 })
    expect(r).toHaveLength(1) // ACTUAL (bug): 3 — _filter ignored (ArkadeWdkAdapter.ts:387)
  })

  it('LiquidWdkAdapter applies limit', async () => {
    const txs = [1, 2, 3].map((i) => ({
      txid: `l${i}`, type: 'incoming', fee: '10', height: 100 + i, timestamp: 1700000000 + i,
      balance: [{ asset_id: 'policy', value: '100' }],
    }))
    const adapter = connected(new LiquidWdkAdapter(), {
      getNetworkInfo: async () => ({ policy_asset: 'policy' }),
      listTransactions: async () => txs,
    })
    const r = await adapter.listTransactions({ limit: 1 })
    expect(r).toHaveLength(1) // ACTUAL (bug): 3 — _filter ignored (LiquidWdkAdapter.ts:302)
  })

  it('ArkadeWdkAdapter returns newest-first like the Spark/RGB adapters', async () => {
    const history = [
      { key: { arkTxid: 'old' }, type: 'RECEIVED', amount: 1, settled: true, createdAt: 1000 },
      { key: { arkTxid: 'new' }, type: 'RECEIVED', amount: 1, settled: true, createdAt: 9000 },
    ]
    const adapter = connected(new ArkadeWdkAdapter(), { getTransactionHistory: async () => history })
    const r = await adapter.listTransactions()
    expect(r[0].id).toBe('new') // ACTUAL (bug): SDK order, unsorted
  })
})

// ---------------------------------------------------------------------------
describe.skip('G-F9: disconnected adapters must throw NOT_CONNECTED, not return success-shaped empties', () => {
  it('SparkWdkAdapter.listTransfers on a fresh adapter', async () => {
    await expect(new SparkWdkAdapter().listTransfers()).rejects.toThrow(/not connected/i)
    // ACTUAL (bug): { transfers: [] } (SparkWdkAdapter.ts:752-755)
  })

  it('ArkadeWdkAdapter.listChannels on a fresh adapter', async () => {
    await expect(new ArkadeWdkAdapter().listChannels()).rejects.toThrow(/not connected/i)
    // ACTUAL (bug): [] (ArkadeWdkAdapter.ts:437-439)
  })

  it('LiquidWdkAdapter.listTransfers on a fresh adapter throws a clean NOT_CONNECTED (not TypeError)', async () => {
    await expect(new LiquidWdkAdapter().listTransfers()).rejects.toThrow(/not connected/i)
    // ACTUAL (bug): TypeError — null account dereference (LiquidWdkAdapter.ts:481-483)
  })

  it('contrast: getBtcBalance on the same fresh adapters throws correctly', async () => {
    await expect(new SparkWdkAdapter().getBtcBalance()).rejects.toThrow(/not connected/i)
    await expect(new ArkadeWdkAdapter().getBtcBalance()).rejects.toThrow(/not connected/i)
  })
})

// ---------------------------------------------------------------------------
describe('G-F12: sendBtcOnchain must not return ok:true with an empty txid', () => {
  it('RlnWdkAdapter throws when the node returns no txid', async () => {
    const adapter = connected(new RlnWdkAdapter(), { sendBtc: async () => ({}) })
    await expect(adapter.sendBtcOnchain({ address: 'bc1qx', amount: 1000 })).rejects.toThrow()
    // ACTUAL (bug): resolves { ok: true, txid: '' } (RlnWdkAdapter.ts:468-472)
  })

  it('RgbLibWdkAdapter throws when the sdk returns an unrecognized shape', async () => {
    const adapter = connected(new RgbLibWdkAdapter(), { sendTransaction: async () => ({}) })
    await expect(adapter.sendBtcOnchain({ address: 'bc1qx', amount: 1000 })).rejects.toThrow()
    // ACTUAL (bug): resolves { ok: true, txid: '' } (RgbLibWdkAdapter.ts:277-281)
  })
})

// ---------------------------------------------------------------------------
describe.skip('G-F13: a second connect() must not leak the previous manager/account', () => {
  it('LiquidWdkAdapter disposes the first manager on re-connect', async () => {
    const managers: any[] = []
    class FakeManager {
      disposed = false
      constructor(public seed: string, public opts: any) {
        managers.push(this)
      }
      async getAccount() {
        return { getBalance: async () => 0n }
      }
      async dispose() {
        this.disposed = true
      }
    }
    registerWdkModule('@kaleidorg/wdk-wallet-liquid', () => ({ default: FakeManager }))

    const adapter = new LiquidWdkAdapter()
    await adapter.connect({ protocol: 'LIQUID', mnemonic: 'seed one', network: 'regtest' } as any)
    await adapter.connect({ protocol: 'LIQUID', mnemonic: 'seed one', network: 'regtest' } as any)
    expect(managers).toHaveLength(2)
    expect(managers[0].disposed).toBe(true) // ACTUAL (bug): false — leaked
  })
})

// ---------------------------------------------------------------------------
describe.skip('G-F14: LiquidWdkAdapter must not double-list L-BTC when getNetworkInfo fails', () => {
  it('listAssets has no empty-id / duplicate L-BTC entries', async () => {
    const adapter = connected(new LiquidWdkAdapter(), {
      getBalance: async () => 1000n,
      getNetworkInfo: async () => {
        throw new Error('esplora down')
      },
      listAssets: async () => [{ asset_id: 'policy-asset-id', balance: '500' }],
    })
    const assets = await adapter.listAssets()
    // ACTUAL (bug): [ {id: '' (L-BTC)}, {id: 'policy-asset-id'} ] — same funds
    // twice, one under an empty id (LiquidWdkAdapter.ts:486-496 + :229).
    for (const a of assets) expect(a.id).not.toBe('')
    expect(assets).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
describe('G-F15: SparkAdapter.decodeInvoice must decode a bolt11 amount (decoder already in scope)', () => {
  it('lnbc2500u… decodes to 250_000 sats', async () => {
    const adapter = new SparkAdapter() // decodeInvoice has no connection requirement
    const d = await adapter.decodeInvoice('lnbc2500u1pexample')
    // decodeBolt11 (used at SparkAdapter.ts:691) parses this as 250_000 sats.
    // ACTUAL (bug): amount undefined, paymentHash '', expiresAt 0 (:648-667).
    expect(d.amount).toBe(250_000)
  })
})

// ---------------------------------------------------------------------------
describe.skip('G-F16: asRgbOperations narrowing must not promise missing methods', () => {
  it('RgbLibWdkAdapter narrows non-null but lacks decodeRgbInvoice/estimateRgbFee', () => {
    const adapter = new RgbLibWdkAdapter()
    const ops = asRgbOperations(adapter as any)
    expect(ops).not.toBeNull() // the narrowing claim
    // …but the group it promises is not there:
    expect((adapter as any).decodeRgbInvoice).toBeUndefined()
    expect((adapter as any).estimateRgbFee).toBeUndefined()
  })
})
