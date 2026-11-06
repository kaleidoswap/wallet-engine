import { describe, it, expect } from 'vitest'
import { RlnWdkAdapter } from '../src/adapters/wdk/RlnWdkAdapter'

function connectedRln() {
  const calls: any[] = []
  const adapter = new RlnWdkAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account: {
      sendRgb: async (p: any) => {
        calls.push(p)
        return { txid: 'deadbeef' }
      },
      estimateFee: async ({ blocks }: { blocks: number }) => ({ fee_rate: blocks }),
    },
  })
  return { adapter, calls }
}

describe('RlnWdkAdapter.sendAsset', () => {
  it('builds a node-shaped recipient_map from flat invoice params', async () => {
    const { adapter, calls } = connectedRln()
    await adapter.sendAsset({
      assetId: 'rgb:asset123',
      recipientId: 'utxob:abc',
      assignment: { type: 'Fungible', value: 42 },
      transportEndpoints: ['rpc://proxy'],
      feeRate: 5,
      donation: false,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      recipientMap: {
        'rgb:asset123': [
          {
            recipient_id: 'utxob:abc',
            assignment: { type: 'Fungible', value: 42 },
            transport_endpoints: ['rpc://proxy'],
          },
        ],
      },
      feeRate: 5,
      donation: false,
      minConfirmations: 1,
    })
  })

  it('derives a Fungible assignment from amount when none is provided', async () => {
    const { adapter, calls } = connectedRln()
    await adapter.sendAsset({
      assetId: 'rgb:asset123',
      recipientId: 'utxob:abc',
      amount: 7,
      transportEndpoints: [],
      feeRate: 2,
    })
    expect(calls[0].recipientMap['rgb:asset123'][0].assignment).toEqual({
      type: 'Fungible',
      value: 7,
    })
  })

  it('forwards witness_data for witness-type recipients', async () => {
    const { adapter, calls } = connectedRln()
    await adapter.sendAsset({
      assetId: 'rgb:asset123',
      recipientId: 'utxob:abc',
      assignment: { type: 'Fungible', value: 1 },
      transportEndpoints: [],
      witnessData: { amount_sat: 1000 },
      feeRate: 1,
    })
    expect(calls[0].recipientMap['rgb:asset123'][0].witness_data).toEqual({ amount_sat: 1000 })
  })

  it('honors a pre-built recipientMap as-is', async () => {
    const { adapter, calls } = connectedRln()
    const recipientMap = { 'rgb:x': [{ recipient_id: 'r', assignment: { type: 'Fungible', value: 1 }, transport_endpoints: [] }] }
    await adapter.sendAsset({ recipientMap, feeRate: 3 })
    expect(calls[0].recipientMap).toBe(recipientMap)
  })
})

describe('RlnWdkAdapter.sendBtcOnchain', () => {
  function rlnWithHistory(sendBtc: () => Promise<unknown>, history: { rows: any[] }) {
    const adapter = new RlnWdkAdapter()
    const listCalls: any[] = []
    Object.assign(adapter as any, {
      connected: true,
      account: {
        sendBtc,
        listTransactions: async (opts: unknown) => {
          listCalls.push(opts)
          return { transactions: history.rows }
        },
      },
    })
    return { adapter, listCalls }
  }
  const row = (txid: string, sent: number, received: number) => ({ txid, sent, received })

  it('returns the node\'s txid', async () => {
    const { adapter } = rlnWithHistory(async () => ({ txid: 'ab'.repeat(32) }), { rows: [] })
    await expect(adapter.sendBtcOnchain({ address: 'tb1qx', amount: 1000 })).resolves.toEqual({
      ok: true,
      txid: 'ab'.repeat(32),
    })
  })

  it('recovers the txid of an accepted send from the history when the answer carries none', async () => {
    const history = { rows: [row('old', 0, 5_000)] }
    const { adapter, listCalls } = rlnWithHistory(async () => {
      history.rows = [row('new', 1_100, 0), ...history.rows]
      return undefined
    }, history)
    await expect(adapter.sendBtcOnchain({ address: 'tb1qx', amount: 1000 })).resolves.toEqual({
      ok: true,
      txid: 'new',
      status: 'pending',
      txidRecovered: true,
    })
    // The pre-send snapshot does not make the node sync; the post-send read does.
    expect(listCalls).toEqual([{ skipSync: true }, undefined])
  })

  it('reports an accepted send the history cannot name yet as ambiguous, not as a failure', async () => {
    const { adapter } = rlnWithHistory(async () => undefined, { rows: [row('old', 0, 5_000)] })
    const failure = await adapter.sendBtcOnchain({ address: 'tb1qx', amount: 1000 }).catch((e) => e)
    expect(failure).toMatchObject({
      code: 'SEND_ACCEPTED_NO_TXID',
      details: { ambiguous: true },
    })
    expect(String(failure.message)).toMatch(/did not return a transaction ID/)
  })
})
