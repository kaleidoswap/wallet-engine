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
    expect(calls[0].assignment).toEqual({ Fungible: 10 })
    expect(calls[0].eps).toEqual(['rpc://proxy.example'])
  })

  it('createRgbInvoice converts the host assignment + honors witness vs blinded', async () => {
    const blind: any[] = []
    const witness: any[] = []
    const adapter = connected({
      blindReceive: async (assetId: any, assignment: any) => {
        blind.push({ assetId, assignment })
        return { invoice: 'blinded', recipient_id: 'b' }
      },
      witnessReceive: async (assetId: any, assignment: any) => {
        witness.push({ assetId, assignment })
        return { invoice: 'witness', recipient_id: 'w' }
      },
    })

    // Blinded (default) with a host { type: 'Fungible', value } assignment.
    await adapter.createRgbInvoice({ assetId: 'rgb:X', assignment: { type: 'Fungible', value: 5 } })
    expect(blind[0]).toEqual({ assetId: 'rgb:X', assignment: { Fungible: 5 } })

    // No amount → the unit "Any" assignment (NOT null).
    await adapter.createRgbInvoice({ assetId: 'rgb:X' })
    expect(blind[1].assignment).toBe('Any')

    // witness:true routes to witnessReceive.
    await adapter.createRgbInvoice({ assetId: 'rgb:X', witness: true })
    expect(witness[0]).toEqual({ assetId: 'rgb:X', assignment: 'Any' })
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
    // No transportEndpoints supplied ⇒ falls back to the wallet's configured ones.
    expect(seen.map['rgb:USDT'][0].transportEndpoints).toEqual(['rpc://proxy.example'])
    // Blinded send ⇒ no witnessData key.
    expect(seen.map['rgb:USDT'][0].witnessData).toBeUndefined()
  })

  it('routes the consignment to the invoice transport endpoints (not the sender default)', async () => {
    const seen: any = {}
    const adapter = connected({
      sendBegin: async (_o: any, map: any) => {
        seen.map = map
        return 'unsigned'
      },
      signPsbt: (p: string) => `signed:${p}`,
      sendEnd: async () => ({ txid: 'sent' }),
    })
    await adapter.sendAsset({
      token: 'rgb:USDT',
      recipient: 'utxob:x',
      amount: 1,
      transportEndpoints: ['rpc://recipient.proxy'],
    })
    expect(seen.map['rgb:USDT'][0].transportEndpoints).toEqual(['rpc://recipient.proxy'])
  })

  it('passes witnessData (camelCase, bigint amountSat) for a witness-invoice send', async () => {
    const seen: any = {}
    const adapter = connected({
      sendBegin: async (_o: any, map: any) => {
        seen.map = map
        return 'unsigned'
      },
      signPsbt: (p: string) => `signed:${p}`,
      sendEnd: async () => ({ txid: 'sent' }),
    })
    await adapter.sendAsset({
      token: 'rgb:USDT',
      recipient: 'witness-rid',
      amount: 7,
      witnessData: { amount_sat: 1200 },
    })
    expect(seen.map['rgb:USDT'][0].witnessData).toEqual({ amountSat: 1200n })
  })

  it('normalizes the rgb-lib transaction type (deposit/send → User, machinery kept)', async () => {
    const adapter = connected({
      listTransactions: () => [
        // External deposit — confirmed, received only.
        { txid: 'dep', received: 53000, sent: 0, transactionType: 'User', confirmationTime: { timestamp: 100 } },
        // Plain BTC send — unrecognized/odd casing must still surface as User.
        { txid: 'wd', received: 0, sent: 21000, transactionType: 'whatever' },
        // RGB machinery — keeps its identity so a host can hide it.
        { txid: 'utxos', received: 0, sent: 600, transactionType: 'CreateUtxos' },
      ],
    })
    const txs = await adapter.listTransactions()
    const byId = Object.fromEntries(txs.map((t) => [t.id, t]))
    expect((byId.dep.protocolData as any).transactionType).toBe('User')
    expect(byId.dep.type).toBe('receive')
    expect((byId.wd.protocolData as any).transactionType).toBe('User')
    expect(byId.wd.type).toBe('send')
    expect((byId.utxos.protocolData as any).transactionType).toBe('CreateUtxos')
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

  it('returns the BTC on-chain address for the "BTC" asset id (not a blinded invoice)', async () => {
    let blindCalled = false
    const adapter = connected({
      getAddress: () => 'bcrt1qbtc',
      blindReceive: async () => {
        blindCalled = true
        return { invoice: 'rgb:should-not-happen' }
      },
    })
    expect(await adapter.getReceiveAddress('BTC')).toMatchObject({
      address: 'bcrt1qbtc',
      format: 'BTC_ADDRESS',
    })
    expect(blindCalled).toBe(false)
  })

  it('normalizes the receive result to a structured-clone-safe object (no BigInt)', async () => {
    const adapter = connected({
      witnessReceive: async () => ({
        invoice: 'witinv',
        recipientId: 'wid',
        // rgb-lib can hand back BigInt — must not leak to the message layer.
        expirationTimestamp: 1700000000n as unknown as number,
        batchTransferIdx: 3n as unknown as number,
      }),
    })
    const inv: any = await adapter.createRgbInvoice({ assetId: 'rgb:X', witness: true })
    expect(typeof inv.expirationTimestamp).toBe('number')
    expect(typeof inv.batchTransferIdx).toBe('number')
    expect(inv.recipient_id).toBe('wid')
    expect(() => structuredClone(inv)).not.toThrow()
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
