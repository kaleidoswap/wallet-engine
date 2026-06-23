import { describe, it, expect } from 'vitest'
import { getCapabilities } from '../src/capabilities'
import { classifyDestination } from '../src/router/destination'
import { CrossProtocolRouter } from '../src/router'
import { ProtocolAdapterRegistry, type IProtocolAdapter } from '../src/adapters/IProtocolAdapter'
import { createWdkRegistry } from '../src/registry/createWdkRegistry'
import { RgbLibWdkAdapter } from '../src/adapters/wdk/RgbLibWdkAdapter'
import { PROTOCOL_OPERATIONS } from '../src/capabilities/operations'
import type { ProtocolType } from '../src/types/base'

describe('RGB_L1 capability manifest', () => {
  it('is on-chain RGB with no Lightning / swaps / channels', () => {
    const c = getCapabilities('RGB_L1')
    expect(c.layers).toEqual(['BTC_L1', 'RGB_L1'])
    expect(c.supportsOnchain).toBe(true)
    expect(c.supportsAssets).toBe(true)
    expect(c.supportsLightning).toBe(false)
    expect(c.supportsSwaps).toBe(false)
    expect(c.needsChannelLiquidity).toBe(false)
    expect(c.wdkModule).toBe('@utexo/wdk-wallet-rgb')
  })

  it('operations include rgb-invoice but no lightning ops', () => {
    const ops = PROTOCOL_OPERATIONS.RGB_L1
    expect(ops).toContain('rgb-invoice')
    expect(ops).toContain('asset-send')
    expect(ops).not.toContain('lightning-send')
    expect(ops).not.toContain('lightning-receive')
  })
})

describe('RGB_L1 routing', () => {
  function stub(protocol: ProtocolType): IProtocolAdapter {
    return {
      protocolName: protocol,
      supportedLayers: [],
      version: 'test',
      capabilities: PROTOCOL_OPERATIONS[protocol],
      isConnected: () => true,
    } as unknown as IProtocolAdapter
  }

  it('is a candidate for an RGB invoice', () => {
    expect(classifyDestination('rgb:utxob:abc').candidates).toContain('RGB_L1')
  })

  it('is a candidate for an on-chain BTC address', () => {
    expect(classifyDestination('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080').candidates).toContain('RGB_L1')
  })

  it('routes an RGB invoice to RGB_L1 when it is the only connected protocol', () => {
    const reg = new ProtocolAdapterRegistry()
    reg.register(stub('RGB_L1'))
    const res = new CrossProtocolRouter(reg).resolveSend('rgb:utxob:abc')
    expect(res.best?.protocol).toBe('RGB_L1')
    expect(res.best?.direct).toBe(true)
  })

  it('is NOT offered for a Lightning invoice (no LN support)', () => {
    const reg = new ProtocolAdapterRegistry()
    reg.register(stub('RGB_L1'))
    const res = new CrossProtocolRouter(reg).resolveSend('lnbc1pexample')
    expect(res.routes.map((r) => r.protocol)).not.toContain('RGB_L1')
    expect(res.best).toBeNull()
  })
})

describe('createWdkRegistry RGB_L1', () => {
  it('registers RGB_L1 only when enabled', () => {
    expect(createWdkRegistry({ enabled: ['RGB_L1'] }).has('RGB_L1')).toBe(true)
    // Not in the default set.
    expect(createWdkRegistry().has('RGB_L1')).toBe(false)
  })
})

describe('RgbLibWdkAdapter', () => {
  function connected(account: Record<string, any>) {
    const adapter = new RgbLibWdkAdapter()
    Object.assign(adapter as any, { connected: true, account, network: 'regtest' })
    return adapter
  }

  it('lists assets with the RGB_L1 profile (BTC via registerWallet, assets via listAssets array)', async () => {
    const adapter = connected({
      // Real API: registerWallet() returns { address, btcBalance } where
      // btcBalance is the vanilla/colored split; listAssets() is a sync array
      // whose entries use camelCase `assetId`.
      registerWallet: async () => ({ address: 'bcrt1q', btcBalance: { vanilla: { settled: 1000, spendable: 1000 } } }),
      listAssets: () => [{ assetId: 'rgb:USDT', ticker: 'USDT', precision: 2, balance: { spendable: 500 } }],
    })
    const assets = await adapter.listAssets()
    expect(assets.map((a) => a.protocol)).toEqual(['RGB_L1', 'RGB_L1'])
    expect(assets[0]).toMatchObject({ id: 'BTC', layer: 'BTC_L1' })
    expect(assets[0].balance.total).toBe(1000)
    const usdt = assets.find((a) => a.id === 'rgb:USDT')!
    expect(usdt.layer).toBe('RGB_L1')
    expect(usdt.balance.total).toBe(500)
    expect(usdt.capabilities.supportsLightning).toBe(false)
    expect(usdt.capabilities.canSwap).toBe(false)
  })

  it('refuses BTC Lightning invoices, LN sends, and invoice decoding (on-chain only)', async () => {
    const adapter = connected({})
    await expect(adapter.createInvoice({ asset: 'BTC' } as any)).rejects.toThrow(/no Lightning/i)
    await expect(adapter.sendPayment({ invoice: 'lnbc1' } as any)).rejects.toThrow(/no Lightning/i)
    await expect(adapter.decodeInvoice('rgb:any')).rejects.toThrow(/does not decode/i)
  })

  it('signs a PSBT via the rgb-lib account', async () => {
    const adapter = connected({ signPsbt: async (p: string) => `signed:${p}` })
    expect(await adapter.signPsbt('psbtbase64')).toEqual({ psbt: 'signed:psbtbase64', unchanged: false })
  })

  it('creates an RGB asset invoice', async () => {
    const adapter = connected({
      receiveAsset: async (p: any) => ({ invoice: `rgb:inv:${p.assetId}`, recipientId: 'rid' }),
    })
    const inv = await adapter.createInvoice({ asset: 'rgb:USDT', assetAmount: 10 } as any)
    expect(inv.invoice).toBe('rgb:inv:rgb:USDT')
    expect(inv.paymentHash).toBe('rid')
  })

  it('does not support swaps', () => {
    expect(connected({}).supportsSwaps()).toBe(false)
  })

  // --- BTC-L1 support (RGB-L1 is RGB + Bitcoin on-chain) -------------------
  it('supports BTC on-chain: address, balance, send', async () => {
    const sent: any[] = []
    const adapter = connected({
      getAddress: async () => 'bcrt1qbtcaddr',
      registerWallet: async () => ({ address: 'bcrt1qbtcaddr', btcBalance: { vanilla: { settled: 2500, spendable: 2500 } } }),
      sendTransaction: async (o: any) => sent.push(o),
    })
    // receive address (no assetId) → a BTC address
    expect(await adapter.getReceiveAddress()).toMatchObject({ address: 'bcrt1qbtcaddr', format: 'BTC_ADDRESS' })
    // balance
    expect(await adapter.getBtcBalance()).toMatchObject({ confirmed: 2500, total: 2500 })
    // on-chain send maps to the rgb-lib sendTransaction({ to, value })
    await adapter.sendBtcOnchain({ address: 'bcrt1qdest', amount: 1000, feeRate: 2 })
    expect(sent[0]).toMatchObject({ to: 'bcrt1qdest', value: 1000, feeRate: 2 })
  })

  it('lists BTC-L1 transaction history', async () => {
    const adapter = connected({
      listTransactions: () => [
        { txid: 'tx1', received: 5000, sent: 0, confirmation_time: { timestamp: 1_700_000 } },
        { txid: 'tx2', received: 0, sent: 1200 },
      ],
    })
    const txs = await adapter.listTransactions()
    expect(txs).toHaveLength(2)
    expect(txs[0]).toMatchObject({ id: 'tx1', type: 'receive', status: 'confirmed', amount: 5000 })
    expect(txs[1]).toMatchObject({ id: 'tx2', type: 'send', status: 'pending', amount: 1200 })
  })
})
