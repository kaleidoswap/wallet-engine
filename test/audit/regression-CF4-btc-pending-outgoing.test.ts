import { describe, expect, it } from 'vitest'
import { rgbAssetBalance } from '../../src/adapters/wdk/RgbCore'
import { convertBtcBalance, convertNodeBalance, convertSdkBalance } from '../../src/lib/rgb-converters'

describe('C-F4 residual: pending is the unsettled portion owned inside total', () => {
  it('does not count an outgoing lock as an incoming pending balance', () => {
    const balance = { settled: 10_000, future: 7_000, spendable: 5_000 }
    const btc = convertBtcBalance({ vanilla: balance } as never)
    const sdk = convertSdkBalance(balance as never)
    const node = convertNodeBalance(balance)

    expect(btc).toMatchObject({ total: 7_000, available: 5_000, pending: 0 })
    expect(btc.pending).toBe(sdk.pending)
    expect(btc.pending).toBe(node.pending)
  })

  it('preserves a legitimate future zero across every RGB balance converter', () => {
    const balance = { settled: 1_000, spendable: 0, future: 0 }
    const converted = [
      convertBtcBalance({ vanilla: balance } as never),
      convertSdkBalance(balance as never),
      convertNodeBalance(balance),
      rgbAssetBalance(balance),
    ]

    for (const result of converted) {
      expect(result).toMatchObject({ total: 0, available: 0, pending: 0 })
    }
  })
})
