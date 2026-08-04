import { describe, it, expect } from 'vitest'
import { liteBucketOf, aggregateForLite, policyFor, LITE_USD } from '../src/disclosure'
import { LIQUID_USDT_ASSET_ID } from '../src/constants'
import type { UnifiedAsset } from '../src/types/base'

function asset(partial: Partial<UnifiedAsset> & { id: string; ticker: string; total: number }): UnifiedAsset {
  return {
    id: partial.id,
    name: partial.name ?? partial.ticker,
    ticker: partial.ticker,
    precision: partial.precision ?? 8,
    protocol: partial.protocol ?? 'RGB_LN',
    layer: partial.layer ?? 'BTC_L1',
    balance: {
      total: partial.total,
      available: partial.total,
      pending: 0,
      totalDisplay: String(partial.total),
      availableDisplay: String(partial.total),
    },
    capabilities: {
      canSend: true,
      canReceive: true,
      canSwap: false,
      supportsLightning: false,
      supportsOnchain: true,
    },
  }
}

describe('policyFor', () => {
  it('lite hides networks, route selector, channels, raw ids', () => {
    const p = policyFor('lite')
    expect(p).toMatchObject({
      level: 'lite',
      showNetworks: false,
      showRouteSelector: false,
      showChannelManagement: false,
      showExperimental: false,
      showRawIds: false,
    })
  })

  it('advanced reveals everything', () => {
    const p = policyFor('advanced')
    expect(p).toMatchObject({
      level: 'advanced',
      showNetworks: true,
      showRouteSelector: true,
      showChannelManagement: true,
      showExperimental: true,
      showRawIds: true,
    })
  })
})

describe('liteBucketOf', () => {
  it('collapses every BTC representation into BTC', () => {
    expect(liteBucketOf(asset({ id: 'BTC', ticker: 'BTC', total: 1 }))).toBe('BTC')
    // L-BTC is identified by the adapter-assigned BTC_LIQUID layer (its id is
    // the network-dependent Liquid policy asset id).
    expect(liteBucketOf(asset({ id: 'x', ticker: 'L-BTC', layer: 'BTC_LIQUID', total: 1 }))).toBe('BTC')
  })

  it('buckets USDt-on-Liquid by asset id', () => {
    expect(liteBucketOf(asset({ id: LIQUID_USDT_ASSET_ID, ticker: 'whatever', total: 1 }))).toBe('USD')
  })

  it('never buckets by ticker — issuer-controlled metadata must not inflate totals', () => {
    // A scam RGB asset tickered like the real thing stays OTHER.
    expect(liteBucketOf(asset({ id: 'rgb:scam1', ticker: 'USDt', layer: 'RGB_LN', total: 1 }))).toBe('OTHER')
    expect(liteBucketOf(asset({ id: 'rgb:scam2', ticker: 'USD', layer: 'RGB_LN', total: 1 }))).toBe('OTHER')
    expect(liteBucketOf(asset({ id: 'rgb:scam3', ticker: 'BTC', layer: 'RGB_LN', total: 1 }))).toBe('OTHER')
    expect(liteBucketOf(asset({ id: 'rgb:scam4', ticker: 'L-BTC', layer: 'RGB_LN', total: 1 }))).toBe('OTHER')
  })

  it('everything else is OTHER', () => {
    expect(liteBucketOf(asset({ id: 'rgb:XAUT', ticker: 'XAUT', total: 1 }))).toBe('OTHER')
  })

  it('LITE_USD points at the Liquid USDt asset id', () => {
    expect(LITE_USD.assetId).toBe(LIQUID_USDT_ASSET_ID)
  })
})

describe('aggregateForLite', () => {
  it('sums BTC and USD buckets and passes others through', () => {
    const r = aggregateForLite([
      asset({ id: 'BTC', ticker: 'BTC', total: 0.5 }),
      asset({ id: 'x', ticker: 'L-BTC', layer: 'BTC_LIQUID', total: 0.25 }),
      asset({ id: 'rgb:fake-usdt', ticker: 'USDt', layer: 'RGB_LN', total: 100 }),
      asset({ id: LIQUID_USDT_ASSET_ID, ticker: 'q', total: 50 }),
      asset({ id: 'rgb:XAUT', ticker: 'XAUT', total: 3 }),
    ])
    expect(r.btc).toBeCloseTo(0.75)
    // The fake-ticker "USDt" does NOT inflate the USD bucket.
    expect(r.usd).toBe(50)
    expect(r.other).toHaveLength(2)
    expect(r.other.map((a) => a.ticker).sort()).toEqual(['USDt', 'XAUT'])
  })

  it('is empty-safe', () => {
    expect(aggregateForLite([])).toEqual({ btc: 0, usd: 0, other: [] })
  })
})
