import { describe, it, expect } from 'vitest'
import { mapRgbStatus, rgbBtcAsset, rgbNiaAsset, rgbAssetBalance, RLN_PROFILE, RGB_L1_PROFILE } from '../src/adapters/wdk/RgbCore'

describe('RgbCore translation helpers', () => {
  it('maps RGB status strings', () => {
    expect(mapRgbStatus('Succeeded')).toBe('confirmed')
    expect(mapRgbStatus('settled')).toBe('confirmed')
    expect(mapRgbStatus('paid')).toBe('confirmed')
    expect(mapRgbStatus('Failed')).toBe('failed')
    expect(mapRgbStatus('pending')).toBe('pending')
    expect(mapRgbStatus(undefined)).toBe('pending')
  })

  it('builds the BTC asset entry for the RLN profile', () => {
    const a = rgbBtcAsset(12345, RLN_PROFILE)
    expect(a).toMatchObject({ id: 'BTC', ticker: 'BTC', protocol: 'RGB_LN', layer: 'BTC_L1' })
    expect(a.balance.total).toBe(12345)
    expect(a.capabilities.supportsLightning).toBe(true)
  })

  it('maps a NIA asset with the RLN (RGB-LN) profile', () => {
    const a = rgbNiaAsset({ asset_id: 'rgb:USDT', ticker: 'USDT', name: 'Tether', precision: 2, balance: { spendable: 500 } }, RLN_PROFILE)
    expect(a).toMatchObject({ id: 'rgb:USDT', ticker: 'USDT', name: 'Tether', precision: 2, protocol: 'RGB_LN', layer: 'RGB_LN' })
    expect(a.balance.total).toBe(500)
    expect(a.capabilities.supportsLightning).toBe(true)
  })

  it('maps a NIA asset with the RGB-L1 profile (no lightning)', () => {
    const a = rgbNiaAsset({ asset_id: 'rgb:XAUT', balance: { settled: 3 } }, RGB_L1_PROFILE)
    expect(a.protocol).toBe('RGB_L1')
    expect(a.layer).toBe('RGB_L1')
    expect(a.capabilities.supportsLightning).toBe(false)
    expect(a.capabilities.canSwap).toBe(false)
    expect(a.balance.total).toBe(3)
  })

  it('shows a just-received asset (spendable 0) at its owned (future) balance', () => {
    // A received, not-yet-spendable asset: settled 0, future 1000, spendable 0.
    expect(rgbAssetBalance({ settled: 0, future: 1000, spendable: 0 })).toMatchObject({
      total: 1000,
      available: 0,
      pending: 1000,
    })
  })

  it('shows a settled asset at its full balance', () => {
    expect(rgbAssetBalance({ settled: 1000, future: 1000, spendable: 1000 })).toMatchObject({
      total: 1000,
      available: 1000,
      pending: 0,
      settled: 1000,
      future: 1000,
      spendable: 1000,
    })
  })

  it('preserves owned balance when rgb-lib returns unified aliases', () => {
    expect(rgbAssetBalance({ total: 2500n, available: 0n })).toMatchObject({
      total: 2500,
      available: 0,
      pending: 0,
      settled: 2500,
      future: 2500,
      spendable: 0,
    })
  })

  it('formats display strings at the asset precision (not raw base units)', () => {
    // 1.00 of an 8-precision asset must render "1.00000000", never "100000000".
    expect(rgbAssetBalance({ settled: 100_000_000, future: 100_000_000, spendable: 100_000_000 }, 8)).toMatchObject({
      totalDisplay: '1.00000000',
      availableDisplay: '1.00000000',
    })
  })

  it('rgbNiaAsset renders display at the record precision', () => {
    const a = rgbNiaAsset(
      { asset_id: 'rgb:x', ticker: 'USDT', precision: 8, balance: { settled: 250_000_000, future: 250_000_000, spendable: 250_000_000 } },
      RGB_L1_PROFILE,
    )
    expect(a.balance.totalDisplay).toBe('2.50000000')
  })

  it('rgbBtcAsset renders BTC display at precision 8', () => {
    expect(rgbBtcAsset(100_000_000, RGB_L1_PROFILE).balance.totalDisplay).toBe('1.00000000')
  })
})
