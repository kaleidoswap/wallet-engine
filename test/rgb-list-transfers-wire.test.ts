/*
 * kaleido-sdk 0.1.21 replaced listTransfers' `asset_id` request field with the
 * `asset_filter` union (AssetFilter::Id). The old field is gone from the node
 * API, so sending it would silently return nothing / error — this pins the
 * request shape the adapter actually puts on the wire.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RgbAdapter } from '../src/adapters/RgbAdapter'

const state = { client: null as any }
vi.mock('../src/lib/kaleido-client-manager', () => ({
  kaleidoClientManager: {
    hasNode: () => true,
    isInitialized: () => true,
    ownsSession: () => true,
    getClient: () => state.client,
    reset: () => {},
  },
}))

function adapter() {
  const a = new RgbAdapter()
  Object.assign(a as any, { connected: true, config: {} })
  return a
}

beforeEach(() => {
  state.client = {
    rln: {
      listTransfers: vi.fn(async () => ({ transfers: [] })),
      listPayments: vi.fn(async () => ({ payments: [] })),
      listSwaps: vi.fn(async () => ({ maker: [], taker: [] })),
      getAssetMetadata: vi.fn(async () => ({ precision: 3 })),
    },
  }
})

describe('RgbAdapter listTransfers wire shape (kaleido-sdk >= 0.1.21)', () => {
  it('listTransactions filters transfers via asset_filter::Id, never the removed asset_id field', async () => {
    await adapter().listTransactions({ asset: 'rgb:NIA' })

    const call = state.client.rln.listTransfers.mock.calls[0]
    expect(call[0]).toEqual({ asset_filter: { type: 'Id', value: 'rgb:NIA' } })
    expect(call[0]).not.toHaveProperty('asset_id')
  })

  it('adapter.listTransfers({asset_id}) maps onto the same asset_filter::Id request', async () => {
    await adapter().listTransfers({ asset_id: 'rgb:NIA' })

    const call = state.client.rln.listTransfers.mock.calls[0]
    expect(call[0]).toEqual({ asset_filter: { type: 'Id', value: 'rgb:NIA' } })
    expect(call[0]).not.toHaveProperty('asset_id')
  })

  it('adapter.listTransfers() without an asset never reaches the node (unfiltered is not a node query anymore)', async () => {
    const out = await adapter().listTransfers()
    expect(out).toEqual({ transfers: [] })
    expect(state.client.rln.listTransfers).not.toHaveBeenCalled()
  })
})
