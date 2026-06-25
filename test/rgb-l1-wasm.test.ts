import { describe, it, expect } from 'vitest'
import { RgbLibWasmAdapter } from '../src/adapters/wdk/RgbLibWasmAdapter'
import { createWdkRegistry } from '../src/registry/createWdkRegistry'

/**
 * Fast unit tests for the WASM RGB-L1 backing. They inject a fake `WasmWallet`
 * account directly (bypassing connect()) so the 13 MB wasm never loads in CI —
 * the goal is to pin the adapter's translation + begin/sign/end orchestration,
 * not the rgb-lib internals (those are validated on-device + in the spike).
 */
describe('RgbLibWasmAdapter', () => {
  function connected(account: Record<string, any>, online: any = { _online: true }) {
    const adapter = new RgbLibWasmAdapter()
    Object.assign(adapter as any, {
      connected: true,
      account,
      online,
      network: 'regtest',
      transportEndpoints: ['rpc://proxy.example'],
    })
    return adapter
  }

  it('reports the RGB_L1 protocol with the wasm version tag', () => {
    const adapter = new RgbLibWasmAdapter()
    expect(adapter.protocolName).toBe('RGB_L1')
    expect(adapter.version).toBe('0.1.0-wasm')
    expect(adapter.supportsSwaps()).toBe(false)
  })

  it('lists assets with the RGB_L1 profile, merging the {nia, ifa} buckets', async () => {
    const adapter = connected({
      getBtcBalance: () => ({ vanilla: { settled: 1000, spendable: 1000 } }),
      listAssets: (_schemas: unknown) => ({
        nia: [{ assetId: 'rgb:USDT', ticker: 'USDT', precision: 2, balance: { spendable: 500 } }],
        ifa: [{ assetId: 'rgb:IFA', ticker: 'IFA', precision: 0, balance: { spendable: 7 } }],
      }),
    })
    const assets = await adapter.listAssets()
    expect(assets.map((a) => a.protocol)).toEqual(['RGB_L1', 'RGB_L1', 'RGB_L1'])
    expect(assets[0]).toMatchObject({ id: 'BTC', layer: 'BTC_L1' })
    expect(assets[0].balance.total).toBe(1000)
    expect(assets.find((a) => a.id === 'rgb:USDT')!.balance.total).toBe(500)
    expect(assets.find((a) => a.id === 'rgb:IFA')!.balance.total).toBe(7)
  })

  it('reads the vanilla BTC balance split', async () => {
    const adapter = connected({
      getBtcBalance: () => ({ vanilla: { settled: 2500, spendable: 2500, future: 2700 } }),
    })
    expect(await adapter.getBtcBalance()).toMatchObject({ confirmed: 2500, unconfirmed: 200, total: 2500 })
  })

  it('refuses BTC Lightning invoices, LN sends, and invoice decoding (on-chain only)', async () => {
    const adapter = connected({})
    await expect(adapter.createInvoice({ asset: 'BTC' } as any)).rejects.toThrow(/no Lightning/i)
    await expect(adapter.sendPayment({ invoice: 'lnbc1' } as any)).rejects.toThrow(/no Lightning/i)
    await expect(adapter.decodeInvoice('rgb:any')).rejects.toThrow(/does not decode/i)
  })

  it('generates a blinded RGB invoice (Fungible assignment from the amount)', async () => {
    const calls: any[] = []
    const adapter = connected({
      blindReceive: async (assetId: any, assignment: any, duration: any, eps: any, minConf: any) => {
        calls.push({ assetId, assignment, duration, eps, minConf })
        return { invoice: `rgb:inv:${assetId}`, recipient_id: 'rid' }
      },
    })
    const inv = await adapter.createInvoice({ asset: 'rgb:USDT', assetAmount: 10 } as any)
    expect(inv.invoice).toBe('rgb:inv:rgb:USDT')
    expect(inv.paymentHash).toBe('rid')
    expect(calls[0].assignment).toEqual({ Fungible: 10n })
    expect(calls[0].eps).toEqual(['rpc://proxy.example'])
  })

  it('sends an asset via begin → signPsbt → end with bigint coercion', async () => {
    const seen: any = {}
    const adapter = connected({
      sendBegin: async (online: any, map: any, donation: any, feeRate: any, minConf: any) => {
        Object.assign(seen, { online, map, donation, feeRate, minConf })
        return 'unsigned-psbt'
      },
      signPsbt: (p: string) => `signed:${p}`,
      sendEnd: async (_online: any, signed: string) => ({ txid: 'sent', signed }),
    })
    const res = await adapter.sendAsset({ token: 'rgb:USDT', recipient: 'utxob:x', amount: 42, feeRate: 3 })
    expect(res).toMatchObject({ txid: 'sent', signed: 'signed:unsigned-psbt' })
    expect(seen.online).toEqual({ _online: true })
    expect(seen.feeRate).toBe(3n)
    expect(seen.map['rgb:USDT'][0]).toMatchObject({ recipientId: 'utxob:x', amount: 42n })
  })

  it('sends BTC on-chain via sendBtcBegin → signPsbt → sendBtcEnd', async () => {
    const seen: any = {}
    const adapter = connected({
      sendBtcBegin: async (_o: any, address: string, amount: any, feeRate: any) => {
        Object.assign(seen, { address, amount, feeRate })
        return 'unsigned'
      },
      signPsbt: (p: string) => `signed:${p}`,
      sendBtcEnd: async () => 'btctxid',
    })
    const res = await adapter.sendBtcOnchain({ address: 'bcrt1qdest', amount: 1000, feeRate: 2 })
    expect(res).toMatchObject({ ok: true, txid: 'btctxid' })
    expect(seen).toMatchObject({ address: 'bcrt1qdest', amount: 1000n, feeRate: 2n })
  })

  it('creates RGB UTXOs via begin → sign → end', async () => {
    const order: string[] = []
    const adapter = connected({
      createUtxosBegin: async () => {
        order.push('begin')
        return 'unsigned'
      },
      signPsbt: (p: string) => {
        order.push('sign')
        return `signed:${p}`
      },
      createUtxosEnd: async () => {
        order.push('end')
        return 3
      },
    })
    expect(await adapter.createRgbUtxos({ num: 3 })).toEqual({ success: true })
    expect(order).toEqual(['begin', 'sign', 'end'])
  })

  it('returns a BTC address from getAddress when no assetId is given', async () => {
    const adapter = connected({ getAddress: () => 'bcrt1qbtc' })
    expect(await adapter.getReceiveAddress()).toMatchObject({ address: 'bcrt1qbtc', format: 'BTC_ADDRESS' })
  })

  it('clears the online handle on disconnect', async () => {
    const adapter = connected({ dispose: async () => {} })
    await adapter.disconnect()
    expect((adapter as any).online).toBeNull()
    expect(adapter.isConnected()).toBe(false)
  })
})

describe('createWdkRegistry rgbL1Backing', () => {
  it('registers the native backing by default and the wasm backing when asked', () => {
    const nativeReg = createWdkRegistry({ enabled: ['RGB_L1'] })
    expect(nativeReg.get('RGB_L1')?.version).toBe('0.1.0-wdk')

    const wasmReg = createWdkRegistry({ enabled: ['RGB_L1'], rgbL1Backing: 'wasm' })
    expect(wasmReg.get('RGB_L1')?.version).toBe('0.1.0-wasm')
  })
})
