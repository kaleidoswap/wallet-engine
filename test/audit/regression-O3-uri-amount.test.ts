import { describe, it, expect } from 'vitest'
import { parseUnifiedReceiveURI, buildUnifiedReceiveURI } from '../../src/receive/unifiedReceive'

/**
 * Audit finding O3 — BIP21/BIP321 define `amount` as a decimal BTC value, but the
 * parser coerced it with a bare `Number()`, which also accepts hex, exponent and
 * whitespace forms. `amount=0x10` was read as 16 BTC by this engine while a
 * spec-compliant wallet reads no valid amount from the same QR.
 */
const amountOf = (v: string) => parseUnifiedReceiveURI(`bitcoin:bc1qx?amount=${encodeURIComponent(v)}`)?.amountBtc
const assetAmountOf = (v: string) => parseUnifiedReceiveURI(`bitcoin:bc1qx?assetamount=${encodeURIComponent(v)}`)?.assetAmount

describe('O3: BIP21 amount= must be a plain decimal', () => {
  it('rejects non-decimal numeric forms', () => {
    for (const v of ['0x10', '0b11', '0o17', '1e3', '0.1e1', 'Infinity', '-Infinity', 'NaN', '1_000']) {
      expect(amountOf(v), `amount=${v}`).toBeUndefined()
    }
  })

  it('rejects whitespace-padded and signed values', () => {
    for (const v of ['  5  ', '+5', '-5', '-0', '.5', '5.', '']) {
      expect(amountOf(v), `amount=${v}`).toBeUndefined()
    }
  })

  it('rejects more than 8 decimal places and above the 21M supply cap', () => {
    expect(amountOf('0.000000001')).toBeUndefined()   // 9 dp — not representable in sats
    expect(amountOf('21000001')).toBeUndefined()      // above max supply
    expect(amountOf('1e300')).toBeUndefined()
  })

  it('accepts every well-formed BIP21 amount', () => {
    expect(amountOf('0.001')).toBe(0.001)
    expect(amountOf('1')).toBe(1)
    expect(amountOf('21000000')).toBe(21000000)
    expect(amountOf('0.00000001')).toBe(0.00000001)
    expect(amountOf('0')).toBe(0)
  })

  it('applies the same decimal grammar to assetamount', () => {
    expect(assetAmountOf('0x10')).toBeUndefined()
    expect(assetAmountOf('1e3')).toBeUndefined()
    expect(assetAmountOf('-1')).toBeUndefined()
    expect(assetAmountOf('123.45')).toBe(123.45)
    // asset precision is not capped at 8 the way BTC is
    expect(assetAmountOf('1.123456789012')).toBe(1.123456789012)
  })

  it('a URI built by this module still round-trips', () => {
    const uri = buildUnifiedReceiveURI({ btcAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amountBtc: 0.00123, assetAmount: 42 })
    const back = parseUnifiedReceiveURI(uri)
    expect(back?.amountBtc).toBe(0.00123)
    expect(back?.assetAmount).toBe(42)
  })
})
