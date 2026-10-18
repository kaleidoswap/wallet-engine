import { describe, it, expect } from 'vitest'
import { base64, hex } from '@scure/base'
import { Transaction, OutScript, p2wpkh } from '@scure/btc-signer'
import { RgbLibWasmAdapter } from '../src/adapters/wdk/RgbLibWasmAdapter'
import { asRgbHtlcOperations } from '../src/adapters/IProtocolAdapter'

const ASSET = 'rgb:2dkSTbr-jFhznbPmo-TQafzswCN-av4gTsJjX-ttx6CNou5-M98k8Zd'
const LOCK_TXID = 'aa'.repeat(32)
const PUBKEY = hex.decode('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')

function connected(account: Record<string, any>, extra: Record<string, any> = {}) {
  const adapter = new RgbLibWasmAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account,
    online: { _online: true },
    network: 'regtest',
    rgbNetwork: 'Regtest',
    transportEndpoints: ['rpcs://proxy.example/json-rpc'],
    wasmModule: {},
    ...extra,
  })
  return adapter
}

function coloredPsbt(): { psbt: string; txid: string } {
  const tx = new Transaction({ allowUnknownOutputs: true })
  tx.addInput({ txid: LOCK_TXID, index: 0, witnessUtxo: { script: p2wpkh(PUBKEY).script, amount: 2000n } })
  tx.addOutput({ script: OutScript.encode({ type: 'unknown', script: hex.decode('6a') }), amount: 0n })
  tx.addOutput({ script: p2wpkh(PUBKEY).script, amount: 1500n })
  return { psbt: base64.encode(tx.toPSBT()), txid: tx.id }
}

const LOCK = {
  recipientId: 'wvout:abc',
  consignmentEndpoint: 'rpcs://proxy.example/json-rpc',
  blinding: '12345678901234567890',
  minConfirmations: 1,
  assetId: ASSET,
  amount: 5_000_000,
  lockTxid: LOCK_TXID,
}

describe('RgbLibWasmAdapter HTLC operations', () => {
  it('is reachable through asRgbHtlcOperations', () => {
    expect(asRgbHtlcOperations(new RgbLibWasmAdapter())).not.toBeNull()
  })

  it('accepts a lock with the expected transfer, then registers the asset', async () => {
    const calls: any[] = []
    const adapter = connected({
      fetchAndAcceptTransferByRecipientId: async (...args: any[]) => {
        calls.push(['fetch', ...args])
        return { consignment: 'c0ffee', assignments: [{ Fungible: 5_000_000 }] }
      },
      saveNewAsset: async (...args: any[]) => calls.push(['save', ...args]),
    })
    expect(await adapter.acceptRgbHtlcLock(LOCK)).toEqual({ status: 'accepted' })
    expect(calls[0]).toEqual([
      'fetch',
      { _online: true },
      'wvout:abc',
      'wvout:abc',
      LOCK.consignmentEndpoint,
      LOCK.blinding,
      1,
      { assetId: ASSET, assetSchema: 'Nia', assignment: { Fungible: 5_000_000 } },
    ])
    expect(calls[1]).toEqual(['save', { _online: true }, 'c0ffee', LOCK_TXID])
  })

  it('reports a lock without enough confirmations as awaiting', async () => {
    let saved = false
    const adapter = connected({
      fetchAndAcceptTransferByRecipientId: async () => {
        throw 'Insufficient confirmations: needed 1, got 0'
      },
      saveNewAsset: async () => {
        saved = true
      },
    })
    expect(await adapter.acceptRgbHtlcLock(LOCK)).toEqual({ status: 'awaitingConfirmations' })
    expect(saved).toBe(false)
  })

  it('refuses a lock that assigns a different amount', async () => {
    const adapter = connected({
      fetchAndAcceptTransferByRecipientId: async () => ({ consignment: 'c0', assignments: [{ Fungible: 1 }] }),
      saveNewAsset: async () => {
        throw new Error('must not save')
      },
    })
    await expect(adapter.acceptRgbHtlcLock(LOCK)).rejects.toThrow(/expected 5000000/)
  })

  it('turns a witness receive into a payout address on the wallet network', async () => {
    const script = p2wpkh(PUBKEY).script
    const adapter = connected(
      {
        witnessReceive: async () => ({ invoice: 'rgb:inv', recipientId: 'bcrt:utxob:x', batchTransferIdx: 3 }),
      },
      { wasmModule: { scriptBufFromRecipientId: () => hex.encode(script) } },
    )
    const out = await adapter.rgbHtlcPayoutAddress({ assetId: ASSET })
    expect(out.recipientId).toBe('bcrt:utxob:x')
    expect(out.address.startsWith('bcrt1q')).toBe(true)
  })

  it('needs a transport endpoint for the payout receive', async () => {
    const adapter = connected({}, { transportEndpoints: [] })
    await expect(adapter.rgbHtlcPayoutAddress()).rejects.toThrow(/transport endpoint/)
  })

  it('colors the spend with the whole amount on the payout output and never expires it', async () => {
    const { psbt, txid } = coloredPsbt()
    const calls: any[] = []
    const adapter = connected({
      psbtOpPrepare: async (...args: any[]) => {
        calls.push(args)
        return {
          operationId: 'op1',
          coloredPsbt: psbt,
          allocations: [{ assetId: ASSET, vout: 1, assignment: { Fungible: 5_000_000 } }],
        }
      },
    })
    const op = await adapter.prepareRgbHtlcSpend({
      psbt: 'cHNidP8=',
      assetId: ASSET,
      outputIndex: 0,
      amount: 5_000_000,
      inputOutpoints: [`${LOCK_TXID}:0`],
    })
    expect(calls[0]).toEqual([
      'cHNidP8=',
      { assetInfoMap: { [ASSET]: { outputMap: { 0: 5_000_000 } } } },
      [{ txid: LOCK_TXID, vout: 0 }],
      1,
      'never',
    ])
    expect(op).toEqual({
      operationId: 'op1',
      coloredPsbt: psbt,
      txid,
      status: 'prepared',
      broadcast: 'not_attempted',
      allocations: [{ assetId: ASSET, vout: 1, amount: 5_000_000 }],
    })
  })

  it('rejects malformed outpoints before calling rgb-lib', async () => {
    const adapter = connected({
      psbtOpPrepare: async () => {
        throw new Error('must not be called')
      },
    })
    await expect(
      adapter.prepareRgbHtlcSpend({ psbt: 'x', assetId: ASSET, outputIndex: 0, amount: 1, inputOutpoints: ['nope'] }),
    ).rejects.toThrow(/Invalid outpoint/)
  })

  it('looks operations up by txid and by spent outpoint', async () => {
    const raw = { operationId: 'op1', coloredPsbt: 'p', txid: 'bb'.repeat(32), status: 'Applied', broadcast: 'Observed', allocations: [] }
    const adapter = connected({
      psbtOpByTxid: async (txid: string) => {
        if (txid === raw.txid) return raw
        throw 'HTLC operation not found: no operation'
      },
      psbtOpsSpending: async (outpoint: any) => (outpoint.txid === LOCK_TXID && outpoint.vout === 0 ? [raw] : []),
    })
    expect((await adapter.getRgbHtlcOperation(raw.txid))?.status).toBe('applied')
    expect(await adapter.getRgbHtlcOperation('cc'.repeat(32))).toBeNull()
    const spending = await adapter.listRgbHtlcOperationsSpending(`${LOCK_TXID}:0`)
    expect(spending.map((o) => [o.operationId, o.broadcast])).toEqual([['op1', 'observed']])
  })

  it('treats a repeated handover as done once the payout receive moved on', async () => {
    const adapter = connected({
      psbtOpProvideReceiveConsignment: async () => {
        throw 'Cannot provide out-of-band consignment: already provided'
      },
      listTransfers: async () => [{ txid: 'dd'.repeat(32), kind: 'ReceiveWitness', status: 'WaitingConfirmations' }],
    })
    expect(
      await adapter.provideRgbHtlcReceive({ operationId: 'op1', assetId: ASSET, txid: 'dd'.repeat(32) }),
    ).toEqual({ status: 'alreadyProvided' })
    await expect(
      adapter.provideRgbHtlcReceive({ operationId: 'op1', assetId: ASSET, txid: 'ee'.repeat(32) }),
    ).rejects.toMatch(/Cannot provide/)
  })

  it('passes the online handle to apply and abort', async () => {
    const calls: any[] = []
    const adapter = connected({
      psbtOpMarkBroadcast: async (id: string) => calls.push(['mark', id]),
      psbtOpApply: async (online: any, id: string) => calls.push(['apply', online, id]),
      psbtOpAbort: async (online: any, id: string) => calls.push(['abort', online, id]),
    })
    await adapter.markRgbHtlcBroadcast('op1')
    await adapter.applyRgbHtlcOperation('op1')
    await adapter.abortRgbHtlcOperation('op2')
    expect(calls).toEqual([
      ['mark', 'op1'],
      ['apply', { _online: true }, 'op1'],
      ['abort', { _online: true }, 'op2'],
    ])
  })
})
