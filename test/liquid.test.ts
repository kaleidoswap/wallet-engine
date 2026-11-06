import { describe, it, expect, vi } from 'vitest'
import {
  LiquidWdkAdapter,
  type LiquidSyncWarning,
} from '../src/adapters/wdk/LiquidWdkAdapter'
import type {
  LiquidSyncWarning as PublicLiquidSyncWarning,
  LiquidSecretsStore as PublicLiquidSecretsStore,
  LiquidOutputSecretsRecord as PublicLiquidOutputSecretsRecord,
} from '../src/adapters/wdk'
import { registerWdkModule } from '../src/adapters/wdk/moduleLoader'
import { LIQUID_USDT_ASSET_ID, LIQUID_TESTNET_USDT_ASSET_ID } from '../src/constants'

/**
 * Fast unit tests for the Liquid (lwk) backing. They inject a fake `account` +
 * `manager` directly (bypassing connect()) so the ~10 MB lwk wasm never loads in CI.
 * The goal is to pin the adapter's translation onto the contract, not lwk internals.
 */
describe('LiquidWdkAdapter', () => {
  const POLICY = 'aaaa1111'.repeat(8).slice(0, 64) // L-BTC policy asset id (mainnet-ish)

  function connected(account: Record<string, any>, manager: Record<string, any> = {}) {
    const adapter = new LiquidWdkAdapter()
    Object.assign(adapter as any, {
      connected: true,
      account,
      manager,
      network: 'mainnet',
    })
    return adapter
  }

  const netInfo = { network: 'liquid', policy_asset: POLICY, address: 'lq1qtest', tip_height: 42 }

  it('reports the LIQUID protocol + its layers, on-chain only (no swaps)', () => {
    const adapter = new LiquidWdkAdapter()
    expect(adapter.protocolName).toBe('LIQUID')
    expect(adapter.supportedLayers).toEqual(['BTC_LIQUID', 'LIQUID_ASSET'])
    expect(adapter.supportsSwaps()).toBe(false)
  })

  it('forwards recoverable Liquid sync warnings to the client callback', async () => {
    let managerConfig: Record<string, unknown> | undefined
    class FakeLiquidWalletManager {
      constructor(_mnemonic: string, config: Record<string, unknown>) {
        managerConfig = config
      }
      async getAccount() {
        return {}
      }
    }
    registerWdkModule('@kaleidorg/wdk-wallet-liquid', () => ({ default: FakeLiquidWalletManager }))

    let receivedWarning: PublicLiquidSyncWarning | undefined
    const adapter = new LiquidWdkAdapter()
    await adapter.connect({
      protocol: 'LIQUID',
      mnemonic: 'test mnemonic',
      network: 'testnet',
      esploraUrl: 'https://waterfalls.example/liquidtestnet/api',
      waterfalls: true,
      allowDefaultEsploraFallback: true,
      onWarning: (warning) => {
        const code: 'LIQUID_WATERFALLS_FALLBACK' = warning.code
        expect(code).toBe('LIQUID_WATERFALLS_FALLBACK')
        receivedWarning = warning
      },
    })

    expect(managerConfig?.allowDefaultEsploraFallback).toBe(true)
    const forwarded = managerConfig?.onWarning as (warning: LiquidSyncWarning) => void
    forwarded({
      code: 'LIQUID_WATERFALLS_FALLBACK',
      message: 'Liquid Waterfalls failed; using standard Esplora fallback.',
      details: { reason: 'waterfalls_failed' },
    })
    expect(receivedWarning?.code).toBe('LIQUID_WATERFALLS_FALLBACK')
  })

  it('forwards a configured secretsStore to the wallet manager', async () => {
    let managerConfig: Record<string, unknown> | undefined
    class FakeLiquidWalletManager {
      constructor(_mnemonic: string, config: Record<string, unknown>) {
        managerConfig = config
      }
      async getAccount() {
        return {}
      }
    }
    registerWdkModule('@kaleidorg/wdk-wallet-liquid', () => ({ default: FakeLiquidWalletManager }))

    const put = vi.fn()
    const secretsStore: PublicLiquidSecretsStore = { put }
    const adapter = new LiquidWdkAdapter()
    await adapter.connect({
      protocol: 'LIQUID',
      mnemonic: 'test mnemonic',
      network: 'mainnet',
      secretsStore,
    })

    // Identity, not shape: the host's store must reach lwk unwrapped, or the
    // records go nowhere and the loss is silent.
    expect(managerConfig?.secretsStore).toBe(secretsStore)

    const records: PublicLiquidOutputSecretsRecord[] = [
      {
        txid: 'ab'.repeat(32),
        vout: 0,
        assetId: 'cd'.repeat(32),
        value: '1000',
        assetBlindingFactor: 'ef'.repeat(32),
        valueBlindingFactor: '12'.repeat(32),
      },
    ]
    await (managerConfig?.secretsStore as PublicLiquidSecretsStore).put(records)
    expect(put).toHaveBeenCalledWith(records)
  })

  it('omits secretsStore when the host configures none', async () => {
    let managerConfig: Record<string, unknown> | undefined
    class FakeLiquidWalletManager {
      constructor(_mnemonic: string, config: Record<string, unknown>) {
        managerConfig = config
      }
      async getAccount() {
        return {}
      }
    }
    registerWdkModule('@kaleidorg/wdk-wallet-liquid', () => ({ default: FakeLiquidWalletManager }))

    const adapter = new LiquidWdkAdapter()
    await adapter.connect({ protocol: 'LIQUID', mnemonic: 'test mnemonic', network: 'mainnet' })

    expect(managerConfig?.secretsStore).toBeUndefined()
  })

  it('lists L-BTC (policy asset) first, then other Liquid assets with known metadata', async () => {
    const adapter = connected({
      getNetworkInfo: async () => netInfo,
      getBalance: async () => 1500n, // L-BTC sats
      listAssets: async () => [
        { asset_id: POLICY, balance: '1500' }, // dropped — already added as L-BTC
        { asset_id: LIQUID_USDT_ASSET_ID, balance: '250' },
        { asset_id: 'deadbeef'.repeat(8), balance: '9' }, // unknown → truncated id ticker
      ],
    })
    const assets = await adapter.listAssets()
    expect(assets.map((a) => a.protocol)).toEqual(['LIQUID', 'LIQUID', 'LIQUID'])

    expect(assets[0]).toMatchObject({ ticker: 'L-BTC', name: 'Liquid Bitcoin', layer: 'BTC_LIQUID' })
    expect(assets[0].balance.total).toBe(1500)

    const usdt = assets.find((a) => a.id === LIQUID_USDT_ASSET_ID)!
    expect(usdt).toMatchObject({ ticker: 'USDt', name: 'Tether USD', layer: 'LIQUID_ASSET' })
    expect(usdt.balance.total).toBe(250)

    const unknown = assets.find((a) => a.id.startsWith('deadbeef'))!
    expect(unknown.ticker).toBe('deadbe') // first 6 chars of the id
    expect(unknown.balance.total).toBe(9)
  })

  it('labels the Liquid Testnet USDt asset with known metadata', async () => {
    const adapter = connected({
      getNetworkInfo: async () => ({ ...netInfo, network: 'liquidtestnet' }),
      getBalance: async () => 0n,
      listAssets: async () => [{ asset_id: LIQUID_TESTNET_USDT_ASSET_ID, balance: '123456789' }],
      getTokenBalance: async () => 123456789n,
    })
    const usdt = (await adapter.listAssets()).find((a) => a.id === LIQUID_TESTNET_USDT_ASSET_ID)!
    expect(usdt).toMatchObject({ ticker: 'USDt', name: 'Tether USD', precision: 8, layer: 'LIQUID_ASSET' })
    expect(usdt.balance.totalDisplay).toBe('1.23456789')

    const balance = await adapter.getAssetBalance(LIQUID_TESTNET_USDT_ASSET_ID)
    expect(balance).toMatchObject({ total: 123456789, totalDisplay: '1.23456789' })
  })

  it('reads the L-BTC balance as confirmed sats', async () => {
    const adapter = connected({ getBalance: async () => 42000n })
    expect(await adapter.getBtcBalance()).toEqual({ confirmed: 42000, unconfirmed: 0, total: 42000 })
  })

  it('reads a single asset balance via getTokenBalance', async () => {
    const adapter = connected({ getTokenBalance: async (id: string) => (id === LIQUID_USDT_ASSET_ID ? 77n : 0n) })
    expect(await adapter.getAssetBalance(LIQUID_USDT_ASSET_ID)).toMatchObject({ total: 77, available: 77 })
  })

  it('returns a confidential Liquid receive address (LIQUID_ADDRESS format)', async () => {
    const adapter = connected({ getAddress: async () => 'lq1qqdeadbeef' })
    expect(await adapter.getReceiveAddress()).toEqual({
      address: 'lq1qqdeadbeef',
      format: 'LIQUID_ADDRESS',
      asset: undefined,
    })
  })

  it('sends L-BTC via account.transfer (invoice carries the recipient address)', async () => {
    const seen: any = {}
    const adapter = connected({
      transfer: async (opts: any) => {
        Object.assign(seen, opts)
        return { hash: 'txid-btc', fee: 120n }
      },
    })
    const res = await adapter.sendPayment({ invoice: '  lq1qdest  ', amount: 1000 } as any)
    expect(seen).toEqual({ recipient: 'lq1qdest', amount: 1000 }) // trimmed
    expect(res).toMatchObject({ paymentHash: 'txid-btc', amount: 1000, fee: 120, status: 'pending' })
  })

  it('requires an explicit amount for an L-BTC send', async () => {
    const adapter = connected({ transfer: async () => ({ hash: 'x', fee: 0n }) })
    await expect(adapter.sendPayment({ invoice: 'lq1qdest' } as any)).rejects.toThrow(/amount/i)
  })

  it('sends a Liquid asset via account.sendAsset (assetId/recipient/amount/feeRate)', async () => {
    const seen: any = {}
    const adapter = connected({
      sendAsset: async (opts: any) => {
        Object.assign(seen, opts)
        return { hash: 'txid-usdt', fee: 90n }
      },
    })
    const res = await adapter.sendAsset({
      assetId: LIQUID_USDT_ASSET_ID,
      address: 'lq1qdest',
      amount: 250,
      feeRate: 0.1,
    })
    // 0.1 sat/vB in, lwk's 100 sat/kvB out.
    expect(seen).toEqual({ assetId: LIQUID_USDT_ASSET_ID, recipient: 'lq1qdest', amount: 250, feeRate: 100 })
    expect(res).toMatchObject({ paymentHash: 'txid-usdt', amount: 250, fee: 90, status: 'pending' })
  })

  it('sendBtcOnchain forwards feeRate + returns a txid', async () => {
    const seen: any = {}
    const adapter = connected({
      transfer: async (opts: any) => {
        Object.assign(seen, opts)
        return { hash: 'btc-onchain', fee: 50n }
      },
    })
    const res = await adapter.sendBtcOnchain({ address: 'lq1qdest', amount: 800, feeRate: 0.2 })
    // sat/vB in, sat/kvB out to lwk — converted once, here.
    expect(seen).toEqual({ recipient: 'lq1qdest', amount: 800, feeRate: 200 })
    expect(res).toMatchObject({ txid: 'btc-onchain', fee: 50, amount: 800 })
  })

  it('never hands lwk a fee rate below the Liquid minimum', async () => {
    const seen: any = {}
    const adapter = connected({
      transfer: async (opts: any) => {
        Object.assign(seen, opts)
        return { hash: 'btc-onchain', fee: 50n }
      },
      sendAsset: async (opts: any) => {
        Object.assign(seen, opts)
        return { hash: 'asset', fee: 50n }
      },
    })
    // A Bitcoin-style "1 sat/vB" must become 1000 sat/kvB, not be read as 1.
    await adapter.sendBtcOnchain({ address: 'lq1qdest', amount: 800, feeRate: 1 })
    expect(seen.feeRate).toBe(1000)
    // The 0.1 sat/vB hint this adapter publishes is lwk's own 100 sat/kvB floor.
    await adapter.sendAsset({ assetId: LIQUID_USDT_ASSET_ID, address: 'lq1qdest', amount: 1, feeRate: 0.1 })
    expect(seen.feeRate).toBe(100)
    await adapter.sendAsset({ assetId: LIQUID_USDT_ASSET_ID, address: 'lq1qdest', amount: 1, feeRate: 0.01 })
    expect(seen.feeRate).toBe(100)
    // No explicit rate: lwk's default, untouched.
    await adapter.sendBtcOnchain({ address: 'lq1qdest', amount: 800 })
    expect(seen.feeRate).toBeUndefined()
  })

  it('reports fee-rate hints in sat/vB, never below the Liquid minimum', async () => {
    const adapter = connected({}, { getFeeRates: async () => ({ normal: 100n, fast: 250n }) })
    expect(await adapter.getFeeRates()).toEqual({ normal: 0.1, fast: 0.25 })
    const placeholder = connected({}, { getFeeRates: async () => ({ normal: 1n, fast: 1n }) })
    expect(await placeholder.getFeeRates()).toEqual({ normal: 0.1, fast: 0.1 })
  })

  it('passes sendMax through as an explicit drain and reports what the recipient got', async () => {
    const seen: any = {}
    const adapter = connected({
      transfer: async (opts: any) => {
        Object.assign(seen, opts)
        return { hash: 'drain', fee: 40n, amount: 9_960n }
      },
    })
    const res = await adapter.sendBtcOnchain({ address: 'lq1qdest', amount: 10_000, sendMax: true })
    expect(seen).toEqual({ recipient: 'lq1qdest', amount: undefined, feeRate: undefined, sendMax: true })
    expect(res).toMatchObject({ txid: 'drain', fee: 40, amount: 9_960 })
  })

  it('disconnect waits for the operation in flight before disposing lwk', async () => {
    let releaseSend!: () => void
    const sendStarted = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    const events: string[] = []
    const account = {
      transfer: async () => {
        events.push('send:start')
        await sendStarted
        events.push('send:done')
        return { hash: 'txid-late', fee: 1n }
      },
      dispose: () => events.push('account:dispose'),
      getBalance: async () => 1n,
    }
    const manager = { dispose: () => events.push('manager:dispose') }
    const adapter = connected(account, manager)

    const send = adapter.sendBtcOnchain({ address: 'lq1qdest', amount: 1 })
    await Promise.resolve() // let the send enter the queue
    const teardown = adapter.disconnect()
    await Promise.resolve()
    // Nothing new is admitted while the teardown waits, and nothing is freed yet.
    expect(adapter.isConnected()).toBe(false)
    await expect(adapter.getBtcBalance()).rejects.toThrow(/not connected|disconnecting/i)
    expect(events).toEqual(['send:start'])

    releaseSend()
    await expect(send).resolves.toMatchObject({ txid: 'txid-late' })
    await teardown
    expect(events).toEqual(['send:start', 'send:done', 'account:dispose', 'manager:dispose'])
  })

  it('maps transactions to send/receive + confirmed/pending, scaling timestamps to ms', async () => {
    const adapter = connected({
      listTransactions: async () => [
        { txid: 'in', type: 'incoming', fee: '10', height: 100, timestamp: 1700 },
        { txid: 'out', type: 'outgoing', fee: '20', height: null, timestamp: null },
      ],
    })
    const byId = (txs: Awaited<ReturnType<typeof adapter.listTransactions>>) =>
      Object.fromEntries(txs.map((tx) => [tx.id, tx]))
    const txs = byId(await adapter.listTransactions())
    expect(txs.in).toMatchObject({ type: 'receive', status: 'confirmed', fee: 10, timestamp: 1700000 })
    // No chain timestamp yet: dated by when this adapter first saw it, not 1970,
    // so it lists with the newest rather than after everything.
    expect(txs.out).toMatchObject({ type: 'send', status: 'pending', fee: 20 })
    expect(txs.out.timestamp).toBeGreaterThan(Date.now() - 5_000)
    expect((await adapter.listTransactions())[0].id).toBe('out')
    // And that date is stable across listings until the chain supplies one.
    const again = byId(await adapter.listTransactions())
    expect(again.out.timestamp).toBe(txs.out.timestamp)
  })

  it('maps a redeposit as a self transfer of its fee, never a receive', async () => {
    const adapter = connected({
      getNetworkInfo: async () => netInfo,
      listTransactions: async () => [
        { txid: 're', type: 'redeposit', fee: '40', height: null, timestamp: null, balance: [{ asset_id: POLICY, value: '-40' }] },
      ],
    })
    const [tx] = await adapter.listTransactions()
    expect(tx).toMatchObject({ id: 're', type: 'self', status: 'pending', fee: 40, amount: 40 })
    expect(tx.asset.id).toBe(POLICY)
  })

  it('derives per-tx amount + asset from lwk balance deltas (L-BTC + Liquid asset)', async () => {
    const adapter = connected({
      getNetworkInfo: async () => netInfo, // supplies the policy (L-BTC) asset id
      listTransactions: async () => [
        // L-BTC receive: +1500 sats, no fee borne by us.
        { txid: 'rx-btc', type: 'incoming', fee: '10', height: 5, timestamp: 1, balance: [{ asset_id: POLICY, value: '1500' }] },
        // L-BTC send: policy delta includes the fee (-1120), so amount = 1120 - 20.
        { txid: 'tx-btc', type: 'outgoing', fee: '20', height: 6, timestamp: 2, balance: [{ asset_id: POLICY, value: '-1120' }] },
        // USDt send: fee is in L-BTC (-30), the headline movement is the asset (-250).
        {
          txid: 'tx-usdt',
          type: 'outgoing',
          fee: '30',
          height: 7,
          timestamp: 3,
          balance: [
            { asset_id: POLICY, value: '-30' },
            { asset_id: LIQUID_USDT_ASSET_ID, value: '-250' },
          ],
        },
      ],
    })
    const txs = await adapter.listTransactions()

    expect(txs[0]).toMatchObject({ id: 'tx-usdt', type: 'send', amount: 250 }) // newest
    expect(txs[0].asset).toMatchObject({ ticker: 'USDt', layer: 'LIQUID_ASSET' })
    expect(txs[0].amountDisplay).toBe('0.00000250')

    expect(txs[1]).toMatchObject({ id: 'tx-btc', type: 'send', amount: 1100 }) // 1120 − 20 fee
    expect(txs[1].asset).toMatchObject({ ticker: 'L-BTC' })
    expect(txs[1].amountDisplay).toBe('0.00001100')

    expect(txs[2]).toMatchObject({ id: 'rx-btc', type: 'receive', amount: 1500 })
    expect(txs[2].asset).toMatchObject({ ticker: 'L-BTC', layer: 'BTC_LIQUID' })
  })

  it('rejects Lightning-only operations (Liquid is on-chain, no invoices/channels)', async () => {
    const adapter = connected({})
    await expect(adapter.createInvoice({ asset: 'BTC' } as any)).rejects.toThrow(/no invoices/i)
    await expect(adapter.decodeInvoice('lnbc1')).rejects.toThrow(/no invoices/i)
    expect(await adapter.listChannels()).toEqual([])
  })

  it('exposes connection info from the lwk network summary', async () => {
    const adapter = connected({ getNetworkInfo: async () => netInfo })
    expect(await adapter.getConnectionInfo()).toEqual({
      protocol: 'LIQUID',
      connected: true,
      network: 'liquid',
      blockHeight: 42,
    })
  })

  it('serializes concurrent lwk operations (no re-entrant wasm access)', async () => {
    // lwk's Wollet panics ("recursive use of an object") if a second call enters
    // mid-flight. The fake account throws if any method is invoked while another
    // runs, so the adapter's opLock must prevent overlap even when the dashboard
    // fires balance + assets + address at once.
    let inFlight = 0
    const guard = async <T>(value: T): Promise<T> => {
      if (inFlight > 0) throw new Error('recursive use of an object detected')
      inFlight++
      try {
        await Promise.resolve() // yield — overlapping callers would collide here
        return value
      } finally {
        inFlight--
      }
    }
    const adapter = connected({
      getNetworkInfo: () => guard(netInfo),
      getBalance: () => guard(1000n),
      getAddress: () => guard('lq1qconcurrent'),
      listAssets: () => guard([{ asset_id: LIQUID_USDT_ASSET_ID, balance: '5' }]),
    })

    // Fire the operations the dashboard/deposit run in parallel.
    const results = await Promise.all([
      adapter.getBtcBalance(),
      adapter.listAssets(),
      adapter.getReceiveAddress(),
      adapter.getConnectionInfo(),
    ])

    expect(results[0].total).toBe(1000)
    expect(results[1].map((a) => a.protocol)).toEqual(['LIQUID', 'LIQUID'])
    expect(results[2].address).toBe('lq1qconcurrent')
    expect(results[3].blockHeight).toBe(42)
  })

  it('forwards every PSET and Simplicity operation without leaking LWK objects', async () => {
    const account = {
      getSimplicityCapabilities: vi.fn(() => ({ version: 'experimental-0.1', available: true })),
      inspectPset: vi.fn(async (pset: string) => ({ pset, uniqueId: 'review-id' })),
      blindPset: vi.fn(async (pset: string) => `blind:${pset}`),
      signPset: vi.fn(async ({ pset }: { pset: string }) => ({
        pset: `signed:${pset}`,
        signedInputIndexes: [1],
        unchanged: false,
      })),
      finalizePset: vi.fn(async (pset: string) => ({ pset, transactionHex: '00', txid: 'final-id' })),
      broadcastPset: vi.fn(async () => ({ txid: 'broadcast-id' })),
      deriveSimplicityPublicKey: vi.fn(async (path?: string) => ({ publicKey: 'pubkey', derivationPath: path })),
      compileSimplicityProgram: vi.fn(async () => ({ cmr: 'cmr', address: 'address' })),
    }
    const adapter = connected(account)

    await expect(adapter.getSimplicityCapabilities()).resolves.toMatchObject({ available: true })
    await expect(adapter.inspectLiquidPset('pset')).resolves.toMatchObject({ uniqueId: 'review-id' })
    await expect(adapter.blindLiquidPset('pset')).resolves.toBe('blind:pset')
    await expect(adapter.signLiquidPset({ pset: 'pset', inputIndexes: [1] }))
      .resolves.toMatchObject({ signedInputIndexes: [1] })
    await expect(adapter.finalizeLiquidPset('signed')).resolves.toMatchObject({ txid: 'final-id' })
    await expect(adapter.broadcastLiquidPset('final')).resolves.toEqual({ txid: 'broadcast-id' })
    await expect(adapter.deriveSimplicityPublicKey('m/1')).resolves.toEqual({
      publicKey: 'pubkey',
      derivationPath: 'm/1',
    })
    await expect(adapter.compileSimplicityProgram({ source: 'main := unit' }))
      .resolves.toMatchObject({ cmr: 'cmr', address: 'address' })

    expect(account.signPset).toHaveBeenCalledWith({ pset: 'pset', inputIndexes: [1] })
    expect(account.compileSimplicityProgram).toHaveBeenCalledWith({ source: 'main := unit' })
  })

  it('degrades cleanly with a pre-Simplicity WDK account', async () => {
    const adapter = connected({})
    await expect(adapter.getSimplicityCapabilities()).resolves.toMatchObject({
      available: false,
      pset: { inspect: false, blind: false, sign: false, finalize: false },
      simplicity: { compile: false, derivePublicKey: false, finalizeTransaction: false },
    })
    await expect(adapter.compileSimplicityProgram({ source: 'main := unit' })).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      protocol: 'LIQUID',
    })
  })

  // In real wdk-wallet-liquid the PSET/Simplicity methods are ALWAYS present on
  // LiquidAccount; whether they work is decided at runtime by
  // getSimplicityCapabilities(). So the `capabilities` manifest the UI gates on must
  // be derived from that probe, never statically claimed.
  it('does not advertise experimental PSET/Simplicity capabilities without runtime support (fail closed)', () => {
    const without = connected({}) // pre-Simplicity account: no capability probe
    expect(without.capabilities).not.toContain('liquid-pset-inspect')
    expect(without.capabilities).not.toContain('liquid-pset-sign')
    expect(without.capabilities).not.toContain('simplicity-compile')
    // The always-on Liquid operations are still advertised.
    expect(without.capabilities).toEqual(
      expect.arrayContaining(['onchain-send', 'onchain-receive', 'asset-send', 'asset-receive']),
    )
  })

  it('advertises experimental capabilities derived from the runtime Simplicity probe', () => {
    const withSimplicity = connected({
      getSimplicityCapabilities: () => ({
        version: 'experimental-0.1',
        available: true,
        pset: { inspect: true, blind: true, sign: true, finalize: true },
        simplicity: { compile: true, derivePublicKey: true, finalizeTransaction: true },
      }),
    })
    expect(withSimplicity.capabilities).toEqual(
      expect.arrayContaining(['liquid-pset-inspect', 'liquid-pset-sign', 'simplicity-compile']),
    )
  })
})
