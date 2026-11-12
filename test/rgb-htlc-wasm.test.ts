import { describe, it, expect } from 'vitest'
import { base64, hex } from '@scure/base'
import { Transaction, OutScript, p2wpkh, Address, TEST_NETWORK } from '@scure/btc-signer'
import { RgbLibWasmAdapter } from '../src/adapters/wdk/RgbLibWasmAdapter'
import { asRgbHtlcOperations } from '../src/adapters/IProtocolAdapter'

const ASSET = 'rgb:2dkSTbr-jFhznbPmo-TQafzswCN-av4gTsJjX-ttx6CNou5-M98k8Zd'
const LOCK_TXID = 'aa'.repeat(32)
const BtcAddressOf = (address: string) => Address({ ...TEST_NETWORK, bech32: 'bcrt' }).decode(address)
const PUBKEY = hex.decode('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')

/** Like the adapter's serializing wrapper: every account call returns a promise. */
function asyncAccount(account: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(account).map(([name, fn]) => [
      name,
      typeof fn === 'function' ? (...args: any[]) => Promise.resolve().then(() => fn(...args)) : fn,
    ]),
  )
}

function connected(account: Record<string, any>, extra: Record<string, any> = {}) {
  const adapter = new RgbLibWasmAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account: asyncAccount(account),
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
  consignment: 'Y29uc2lnbm1lbnQ=',
  blinding: '12345678901234567890',
  minConfirmations: 1,
  assetId: ASSET,
  amount: 5_000_000,
  lockTxid: LOCK_TXID,
  lockVout: 1,
}

describe('RgbLibWasmAdapter HTLC operations', () => {
  it('is reachable through asRgbHtlcOperations', () => {
    expect(asRgbHtlcOperations(new RgbLibWasmAdapter())).not.toBeNull()
  })

  it('refuses every HTLC step on a build without the PSBT-operation bindings', async () => {
    const adapter = connected({})
    const notSupported = { code: 'NOT_SUPPORTED' }
    await expect(adapter.acceptRgbHtlcLock(LOCK)).rejects.toMatchObject(notSupported)
    await expect(adapter.rgbHtlcPayoutAddress()).rejects.toMatchObject(notSupported)
    await expect(
      adapter.prepareRgbHtlcSpend({ psbt: '', assetId: ASSET, outputIndex: 1, amount: 1, inputOutpoints: [`${LOCK_TXID}:0`] }),
    ).rejects.toMatchObject(notSupported)
    await expect(adapter.getRgbHtlcOperation(LOCK_TXID)).rejects.toMatchObject(notSupported)
    await expect(adapter.applyRgbHtlcOperation('op')).rejects.toMatchObject(notSupported)
    await expect(adapter.abortRgbHtlcOperation('op')).rejects.toMatchObject(notSupported)
    await expect(
      adapter.fundRgbHtlcLock({ assetId: ASSET, amount: 1, recipientId: 'wvout:x', blinding: '1', htlcSat: 1000 }),
    ).rejects.toMatchObject(notSupported)
  })

  it('accepts a handed-over lock with the expected transfer, then registers the asset', async () => {
    const calls: any[] = []
    const adapter = connected({
      acceptHtlcConsignment: async (...args: any[]) => {
        calls.push(['accept', ...args])
        return { consignment: 'c0ffee', assignments: [{ Fungible: 5_000_000 }] }
      },
      saveNewAsset: async (...args: any[]) => calls.push(['save', ...args]),
    })
    expect(await adapter.acceptRgbHtlcLock(LOCK)).toEqual({ status: 'accepted' })
    expect(calls[0]).toEqual([
      'accept',
      { _online: true },
      LOCK.consignment,
      LOCK_TXID,
      1,
      'wvout:abc',
      LOCK.blinding,
      1,
      { assetId: ASSET, assetSchema: 'Nia', assignment: { Fungible: 5_000_000 } },
    ])
    expect(calls[1]).toEqual(['save', { _online: true }, 'c0ffee', LOCK_TXID])
  })

  it.each([
    ['no consignment', { consignment: '' }],
    ['a negative vout', { lockVout: -1 }],
    ['a fractional vout', { lockVout: 0.5 }],
  ])('refuses a lock with %s before calling rgb-lib', async (_label, patch) => {
    const adapter = connected({
      acceptHtlcConsignment: async () => {
        throw new Error('must not be called')
      },
    })
    await expect(adapter.acceptRgbHtlcLock({ ...LOCK, ...patch })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  })

  it('reports a lock without enough confirmations as awaiting', async () => {
    let saved = false
    const adapter = connected({
      acceptHtlcConsignment: async () => {
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
      acceptHtlcConsignment: async () => ({ consignment: 'c0', assignments: [{ Fungible: 1 }] }),
      saveNewAsset: async () => {
        throw new Error('must not save')
      },
    })
    await expect(adapter.acceptRgbHtlcLock(LOCK)).rejects.toThrow(/expected 5000000/)
  })

  it('pays the HTLC out to a fresh colored address, with no receive', async () => {
    const address = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'
    const seen: any[] = []
    const adapter = connected(
      {
        getColoredAddress: () => address,
        witnessReceive: async () => {
          throw new Error('must not open a receive')
        },
      },
      {
        transportEndpoints: [],
        wasmModule: {
          recipientIdFromScriptBuf: (scriptHex: string, network: string) => {
            seen.push([scriptHex, network])
            return 'bcrt:wvout:payout'
          },
        },
      },
    )
    const out = await adapter.rgbHtlcPayoutAddress({ assetId: ASSET })
    expect(out).toEqual({ address, recipientId: 'bcrt:wvout:payout' })
    expect(seen).toEqual([[hex.encode(OutScript.encode(BtcAddressOf(address))), 'Regtest']])
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
      psbtOpsSpending: async (outpoint: any) =>
        outpoint.txid === LOCK_TXID
          ? [{ operationId: 'other', txid: 'ee'.repeat(32) }, { operationId: 'op1', txid }]
          : [],
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

describe('RgbLibWasmAdapter.fundRgbHtlcLock', () => {
  const FUND = {
    assetId: ASSET,
    amount: 5_000_000,
    recipientId: 'wvout:maker',
    blinding: '18446744073709551557',
    htlcSat: 1_000,
    minConfirmations: 1,
  }
  const HANDED = {
    consignment: 'Y29uc2lnbm1lbnQ=',
    txid: 'lock-txid',
    recipients: [{ recipientId: 'wvout:maker', vout: 2 }],
  }

  function sender(seen: any[], txid: unknown = 'lock-txid', handed: unknown = HANDED) {
    return connected({
      sync: async () => {},
      refresh: async () => ({}),
      sendBegin: async (_o: any, map: any, donation: any, feeRate: any, minConf: any, _exp: any, senderEndpoint: any) => {
        seen.push({ map, donation, feeRate, minConf, senderEndpoint })
        return { psbt: 'unsigned' }
      },
      signPsbt: (p: string) => `signed:${p}`,
      sendEnd: async () => ({ txid }),
      getOutOfBandTransfer: (t: string, asset: string) => (t === 'lock-txid' && asset === ASSET ? handed : null),
    })
  }

  it('sends an out-of-band donation with the u64 blinding unrounded and hands its consignment back', async () => {
    const seen: any[] = []
    expect(await sender(seen).fundRgbHtlcLock(FUND)).toEqual({
      txid: 'lock-txid',
      vout: 2,
      consignment: 'Y29uc2lnbm1lbnQ=',
    })
    const recipient = seen[0].map[ASSET][0]
    expect(recipient.recipientId).toBe('wvout:maker')
    expect(recipient.assignment).toEqual({ Fungible: 5_000_000 })
    expect(recipient.witnessData).toEqual({ amountSat: '1000', amount_sat: '1000', blinding: '18446744073709551557' })
    expect(recipient.transportEndpoints).toEqual([])
    expect(seen[0].donation).toBe(true)
    expect(seen[0].senderEndpoint).toBeNull()
    expect(seen[0].minConf).toBe(1)
  })

  it('needs no transport endpoint of its own', async () => {
    const seen: any[] = []
    const adapter = sender(seen)
    ;(adapter as any).transportEndpoints = []
    await expect(adapter.fundRgbHtlcLock(FUND)).resolves.toMatchObject({ vout: 2 })
  })

  it('names the broadcast lock when its consignment cannot be read back', async () => {
    await expect(
      sender([], 'lock-txid', { ...HANDED, recipients: [{ recipientId: 'wvout:other', vout: 1 }] }).fundRgbHtlcLock(FUND),
    ).rejects.toMatchObject({ code: 'SEND_ERROR', message: expect.stringContaining('lock-txid') })
  })

  it.each([
    ['a non-decimal blinding', { blinding: '0x10' }],
    ['a blinding above u64', { blinding: '18446744073709551616' }],
    ['a fractional amount', { amount: 1.5 }],
    ['zero HTLC sats', { htlcSat: 0 }],
    ['no recipient', { recipientId: '' }],
  ])('refuses %s before sending', async (_label, patch) => {
    const seen: any[] = []
    await expect(sender(seen).fundRgbHtlcLock({ ...FUND, ...patch })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    expect(seen).toHaveLength(0)
  })

  it('fails when the send returns no txid', async () => {
    await expect(sender([], null).fundRgbHtlcLock(FUND)).rejects.toMatchObject({ code: 'SEND_ERROR' })
  })
})

describe('RgbLibWasmAdapter HTLC capability after connect', () => {
  async function connectWith(wallet: Record<string, unknown>) {
    const { registerWdkModule } = await import('../src/adapters/wdk/moduleLoader')
    registerWdkModule('@utexo/rgb-lib-wasm', () => ({
      init: () => {},
      restoreKeys: () => ({ mnemonic: 'm', masterFingerprint: 'aa', accountXpubVanilla: 'x1', accountXpubColored: 'x2' }),
      WasmWallet: { create: async () => ({ goOnline: async () => ({}), ...wallet }) },
    }))
    const adapter = new RgbLibWasmAdapter()
    await adapter.connect({
      protocol: 'RGB_L1',
      network: 'regtest',
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      indexerUrl: 'http://indexer',
    } as any)
    return adapter
  }

  it('is not reported on a build without the PSBT-operation bindings', async () => {
    const adapter = await connectWith({})
    expect(asRgbHtlcOperations(adapter)).toBeNull()
    expect(typeof (adapter as any).fundRgbHtlcLock).toBe('undefined')
  })

  it('is not reported on a build without the out-of-band bindings', async () => {
    const adapter = await connectWith({ psbtOpPrepare: async () => ({}) })
    expect(asRgbHtlcOperations(adapter)).toBeNull()
  })

  it('is reported on a build that ships them', async () => {
    const adapter = await connectWith({
      psbtOpPrepare: async () => ({}),
      acceptHtlcConsignment: async () => ({}),
      getOutOfBandTransfer: () => ({}),
    })
    expect(asRgbHtlcOperations(adapter)).not.toBeNull()
  })
})
