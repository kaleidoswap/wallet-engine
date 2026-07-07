import { describe, it, expect } from 'vitest'
import { RlnWdkAdapter } from '../src/adapters/wdk/RlnWdkAdapter'

/**
 * sendAsset must translate the extension's flat, decoded-invoice params into the
 * node-shaped recipient_map the WDK account expects. Passing the flat params
 * straight through left recipientMap undefined and the RLN node rejected the
 * body with "Failed to deserialize the JSON body into the target type".
 */
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
