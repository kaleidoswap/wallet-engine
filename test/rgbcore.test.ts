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

  it('maps a balance with future → pending', () => {
    expect(rgbAssetBalance({ spendable: 10, future: 4 })).toMatchObject({ total: 10, pending: 4 })
  })
})
