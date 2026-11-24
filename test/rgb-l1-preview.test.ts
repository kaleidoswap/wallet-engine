import { describe, it, expect, vi } from 'vitest'
import { RgbLibWasmAdapter, toRgbPsbtSummary } from '../src/adapters/wdk/RgbLibWasmAdapter'

// Shape captured from rgb-lib-wasm 1.0.0-beta.5 inspectPsbt: amounts are BigInt.
const INSPECTION = {
  txid: '97956158a6ef88637f9b6f9ba7727cca8166a9eda957960d6333bda71a057daf',
  inputs: [{ outpoint: { txid: '11'.repeat(32), vout: 0 }, amountSat: 100000n, isMine: true }],
  outputs: [
    { address: 'tb1pmine', scriptPubkeyHex: '5120aa', amountSat: 60000n, isOpReturn: false, isMine: true },
    { address: 'tb1qdest', scriptPubkeyHex: '0014bb', amountSat: 39000n, isOpReturn: false, isMine: false },
  ],
  totalInputSat: 100000n,
  totalOutputSat: 99000n,
  feeSat: 1000n,
  signatureCount: 0,
  sizeVbytes: 125n,
}

const EXPIRATION = Math.floor(Date.now() / 1000) + 86_400
const INVOICE = 'rgb:USDT/blinded'
const wasmModule = {
  WasmInvoice: class {
    invoiceData() {
      return {
        recipientId: 'utxob:x',
        assetId: 'rgb:USDT',
        transportEndpoints: ['rpc://recipient.proxy'],
        publicKey: 'aa'.repeat(32),
        encryption: 'Required',
        expirationTimestamp: BigInt(EXPIRATION),
      }
    }
  },
}

function connected(account: Record<string, any>) {
  const adapter = new RgbLibWasmAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account: {
      sync: async () => {},
      refresh: async () => new Map(),
      inspectPsbt: () => INSPECTION,
      flush: async () => {},
      ...account,
    },
    online: { _online: true },
    network: 'regtest',
    transportEndpoints: ['rpc://proxy.example'],
    wasmModule,
  })
  return adapter
}

describe('RGB-L1 previews and inspection', () => {
  it('turns an inspection into plain numbers and outpoint strings', () => {
    expect(toRgbPsbtSummary(INSPECTION)).toEqual({
      txid: INSPECTION.txid,
      inputs: [{ outpoint: `${'11'.repeat(32)}:0`, amountSat: 100000, isMine: true }],
      outputs: [
        { address: 'tb1pmine', amountSat: 60000, isOpReturn: false, isMine: true },
        { address: 'tb1qdest', amountSat: 39000, isOpReturn: false, isMine: false },
      ],
      totalInputSat: 100000,
      totalOutputSat: 99000,
      feeSat: 1000,
      sizeVbytes: 125,
      signatureCount: 0,
    })
    expect(JSON.stringify(toRgbPsbtSummary(INSPECTION))).toContain('"feeSat":1000')
  })

  it('refuses an inspection with a missing or invalid amount instead of showing zero', () => {
    for (const bad of [
      { ...INSPECTION, feeSat: undefined },
      { ...INSPECTION, feeSat: -1n },
      { ...INSPECTION, totalOutputSat: 1.5 },
      { ...INSPECTION, inputs: [{ ...INSPECTION.inputs[0], amountSat: null }] },
      { ...INSPECTION, outputs: undefined },
    ]) {
      expect(() => toRgbPsbtSummary(bad)).toThrow(/PSBT inspection/)
    }
  })

  it('previews an asset send as a dry run that signs and broadcasts nothing', async () => {
    const sendBegin = vi.fn(async () => ({ psbt: 'psbt-b64', batchTransferIdx: null }))
    const signPsbt = vi.fn()
    const sendEnd = vi.fn()
    const adapter = connected({ sendBegin, signPsbt, sendEnd })
    const summary = await adapter.previewSendAsset({ token: 'rgb:USDT', recipient: INVOICE, amount: 5, feeRate: 2 })
    expect(summary.feeSat).toBe(1000)
    expect(sendBegin).toHaveBeenCalledTimes(1)
    const args = sendBegin.mock.calls[0] as unknown[]
    expect(args[8]).toBe(true) // dryRun
    expect(signPsbt).not.toHaveBeenCalled()
    expect(sendEnd).not.toHaveBeenCalled()
  })

  it('previews a BTC send and UTXO creation as dry runs', async () => {
    const sendBtcBegin = vi.fn(async () => 'psbt-b64')
    const createUtxosBegin = vi.fn(async () => 'psbt-b64')
    const signPsbt = vi.fn()
    const adapter = connected({ sendBtcBegin, createUtxosBegin, signPsbt })
    expect((await adapter.previewSendBtc({ address: 'bcrt1qdest', amount: 1000 })).totalInputSat).toBe(100000)
    expect((sendBtcBegin.mock.calls[0] as unknown[])[5]).toBe(true)
    await adapter.previewCreateRgbUtxos({ num: 3, size: 1000 })
    expect((createUtxosBegin.mock.calls[0] as unknown[])[7]).toBe(true)
    expect(signPsbt).not.toHaveBeenCalled()
  })

  it('inspects a PSBT through the wallet', async () => {
    const inspectPsbt = vi.fn(() => INSPECTION)
    const summary = await connected({ inspectPsbt }).inspectRgbPsbt('psbt-b64')
    expect(inspectPsbt).toHaveBeenCalledWith('psbt-b64')
    expect(summary.outputs.filter((o) => o.isMine)).toHaveLength(1)
  })

  it('passes the abort signal to the sync and the begin call', async () => {
    const signal = new AbortController().signal
    const sync = vi.fn(async () => {})
    const createUtxosBegin = vi.fn(async () => 'psbt-b64')
    const adapter = connected({ sync, createUtxosBegin })
    await adapter.previewCreateRgbUtxos({ num: 1, signal })
    for (const call of sync.mock.calls as unknown[][]) expect(call[2]).toBe(signal)
    expect((createUtxosBegin.mock.calls[0] as unknown[])[8]).toBe(signal)
  })

  it('stops a send before anything is signed when the begin call is aborted', async () => {
    const controller = new AbortController()
    const signPsbt = vi.fn()
    const adapter = connected({
      sendBegin: async () => {
        controller.abort()
        throw new Error('Aborted')
      },
      signPsbt,
    })
    await expect(
      adapter.sendAsset({ token: 'rgb:USDT', recipient: INVOICE, amount: 5, signal: controller.signal }),
    ).rejects.toThrow('Aborted')
    expect(signPsbt).not.toHaveBeenCalled()
  })

  it('imports an asset from a base64 consignment and persists it', async () => {
    const saveNewAsset = vi.fn(async () => {})
    const flush = vi.fn(async () => {})
    const adapter = connected({ saveNewAsset, flush })
    await adapter.importRgbAsset({ consignment: btoa('\x01\x02\x03'), txid: 'ab'.repeat(32) })
    const [, bytes, txid] = saveNewAsset.mock.calls[0] as unknown[]
    expect(Array.from(bytes as Uint8Array)).toEqual([1, 2, 3])
    expect(txid).toBe('ab'.repeat(32))
    expect(flush).toHaveBeenCalled()
  })
})
