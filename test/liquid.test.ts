import { describe, it, expect } from 'vitest'
import {
  LiquidWdkAdapter,
  type LiquidSyncWarning,
} from '../src/adapters/wdk/LiquidWdkAdapter'
import type { LiquidSyncWarning as PublicLiquidSyncWarning } from '../src/adapters/wdk'
import { registerWdkModule } from '../src/adapters/wdk/moduleLoader'
import { LIQUID_USDT_ASSET_ID } from '../src/constants'

/**
 * Fast unit tests for the Liquid (lwk) backing. They inject a fake `account` +
 * `manager` directly (bypassing connect()) so the ~10 MB lwk wasm never loads in
 * CI — the goal is to pin the adapter's translation onto the IProtocolAdapter
 * contract (asset mapping, send param shaping, tx mapping, on-chain-only guards),
 * not lwk internals (those are validated on-device + upstream).
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
    expect(seen).toEqual({ assetId: LIQUID_USDT_ASSET_ID, recipient: 'lq1qdest', amount: 250, feeRate: 0.1 })
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
    expect(seen).toEqual({ recipient: 'lq1qdest', amount: 800, feeRate: 0.2 })
    expect(res).toMatchObject({ txid: 'btc-onchain', fee: 50 })
  })

  it('normalizes lwk fee-rate bigints to numbers', async () => {
    const adapter = connected({}, { getFeeRates: async () => ({ normal: 100n, fast: 250n }) })
    expect(await adapter.getFeeRates()).toEqual({ normal: 100, fast: 250 })
  })

  it('maps transactions to send/receive + confirmed/pending, scaling timestamps to ms', async () => {
    const adapter = connected({
      listTransactions: async () => [
        { txid: 'in', type: 'incoming', fee: '10', height: 100, timestamp: 1700 },
        { txid: 'out', type: 'outgoing', fee: '20', height: null, timestamp: null },
      ],
    })
    const txs = await adapter.listTransactions()
    expect(txs[0]).toMatchObject({ id: 'in', type: 'receive', status: 'confirmed', fee: 10, timestamp: 1700000 })
    expect(txs[1]).toMatchObject({ id: 'out', type: 'send', status: 'pending', fee: 20, timestamp: 0 })
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

    expect(txs[0]).toMatchObject({ id: 'rx-btc', type: 'receive', amount: 1500 })
    expect(txs[0].asset).toMatchObject({ ticker: 'L-BTC', layer: 'BTC_LIQUID' })

    expect(txs[1]).toMatchObject({ id: 'tx-btc', type: 'send', amount: 1100 }) // 1120 − 20 fee
    expect(txs[1].asset).toMatchObject({ ticker: 'L-BTC' })

    expect(txs[2]).toMatchObject({ id: 'tx-usdt', type: 'send', amount: 250 }) // asset delta, not the fee
    expect(txs[2].asset).toMatchObject({ ticker: 'USDt', layer: 'LIQUID_ASSET' })
    expect(txs[2].amountDisplay).toBe('250')
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
    // while the first is mid-flight. Simulate that: the fake account throws if any
    // method is invoked while another is still running. The adapter's opLock must
    // prevent overlap even when the dashboard fires balance + assets + address at once.
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
})
