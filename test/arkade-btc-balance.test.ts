import { describe, it, expect } from 'vitest'
import { normalizeVtxos, summarizeBtcVtxos } from '../src/lib/arkade-helpers'

const vtxo = (txid: string, value: number, state: string, assets?: unknown[]) => ({
  txid,
  vout: 0,
  value,
  virtualStatus: { state },
  ...(assets ? { assets } : {}),
})

describe('summarizeBtcVtxos', () => {
  it('sums plain VTXOs into settled, preconfirmed and recoverable', () => {
    const vtxos = normalizeVtxos([
      vtxo('a', 1_000, 'settled'),
      vtxo('b', 2_000, 'preconfirmed'),
      vtxo('c', 3_000, 'swept'),
    ])
    expect(summarizeBtcVtxos(vtxos)).toEqual({ settled: 1_000, preconfirmed: 2_000, recoverable: 3_000 })
  })

  it('leaves out VTXOs that carry assets, whatever their state', () => {
    const asset = [{ assetId: 'asset-1', amount: 5 }]
    const vtxos = normalizeVtxos([
      vtxo('a', 1_000, 'settled'),
      vtxo('b', 100_000_000, 'settled', asset),
      vtxo('c', 330, 'preconfirmed', asset),
      vtxo('d', 330, 'swept', asset),
    ])
    expect(summarizeBtcVtxos(vtxos)).toEqual({ settled: 1_000, preconfirmed: 0, recoverable: 0 })
  })

  it('counts a VTXO whose asset list is empty or invalid as plain BTC', () => {
    const vtxos = normalizeVtxos([
      vtxo('a', 1_000, 'settled', []),
      vtxo('b', 2_000, 'settled', [{ assetId: '', amount: 5 }]),
    ])
    expect(summarizeBtcVtxos(vtxos).settled).toBe(3_000)
  })
})
