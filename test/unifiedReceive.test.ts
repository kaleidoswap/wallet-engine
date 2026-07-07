import { describe, it, expect } from 'vitest'
import { buildUnifiedReceiveURI, parseUnifiedReceiveURI, receiveMethodsOf } from '../src/receive/unifiedReceive'

describe('buildUnifiedReceiveURI', () => {
  it('builds a BIP321 URI with address + amount + lightning + asset params', () => {
    const uri = buildUnifiedReceiveURI({
      btcAddress: 'bc1qexample',
      amountBtc: 0.001,
      lightningInvoice: 'lnbc1pxyz',
      sparkAddress: 'spark1qxyz',
      rgbInvoice: 'rgb:utxob:abc',
    })
    expect(uri.startsWith('bitcoin:bc1qexample?')).toBe(true)
    expect(uri).toContain('amount=0.001')
    expect(uri).toContain('lightning=lnbc1pxyz')
    expect(uri).toContain('spark=spark1qxyz')
    expect(uri).toContain(`rgb=${encodeURIComponent('rgb:utxob:abc')}`)
  })

  it('omits the address under BIP321 (LN/asset-only QR)', () => {
    const uri = buildUnifiedReceiveURI({ lightningInvoice: 'lnbc1pxyz' })
    expect(uri.startsWith('bitcoin:?')).toBe(true)
    expect(uri).toContain('lightning=lnbc1pxyz')
  })

  it('throws when no receive method is supplied', () => {
    expect(() => buildUnifiedReceiveURI({})).toThrow(/at least one receive method/i)
  })

  it('formats BTC amounts without trailing zeros or exponent', () => {
    expect(buildUnifiedReceiveURI({ btcAddress: 'bc1q', amountBtc: 1 })).toContain('amount=1')
    expect(buildUnifiedReceiveURI({ btcAddress: 'bc1q', amountBtc: 0.1 })).toContain('amount=0.1')
  })

  it('never emits a zero, negative, non-finite, or sub-sat (rounds-to-0) amount', () => {
    for (const amountBtc of [0, -0.001, Number.NaN, Number.POSITIVE_INFINITY, 0.000000001]) {
      const uri = buildUnifiedReceiveURI({ btcAddress: 'bc1q', amountBtc })
      expect(uri, `amountBtc=${amountBtc}`).not.toContain('amount=')
    }
  })

  it('never emits a zero/negative asset amount', () => {
    for (const assetAmount of [0, -5, Number.NaN]) {
      const uri = buildUnifiedReceiveURI({ rgbInvoice: 'rgb:utxob:abc', assetId: 'rgb:x', assetAmount })
      expect(uri, `assetAmount=${assetAmount}`).not.toContain('assetamount=')
    }
  })
})

describe('parseUnifiedReceiveURI round-trip', () => {
  it('round-trips a full URI', () => {
    const params = {
      btcAddress: 'bc1qexample',
      amountBtc: 0.001,
      label: 'tip jar',
      lightningInvoice: 'lnbc1pxyz',
      liquidAddress: 'lq1qexample',
      rgbInvoice: 'rgb:utxob:abc',
    }
    const parsed = parseUnifiedReceiveURI(buildUnifiedReceiveURI(params))
    expect(parsed).toMatchObject(params)
  })

  it('parses an address-omitted URI', () => {
    const parsed = parseUnifiedReceiveURI('bitcoin:?lightning=lnbc1pxyz&liquid=lq1qexample')
    expect(parsed?.btcAddress).toBeUndefined()
    expect(parsed?.lightningInvoice).toBe('lnbc1pxyz')
    expect(parsed?.liquidAddress).toBe('lq1qexample')
  })

  it('returns null for a non-bitcoin URI', () => {
    expect(parseUnifiedReceiveURI('https://example.com')).toBeNull()
    expect(parseUnifiedReceiveURI('lnbc1pxyz')).toBeNull()
  })

  // --- Amount guards (S5): junk amounts must not surface as NaN ----------
  it('does not surface a NaN amount for junk input', () => {
    const parsed = parseUnifiedReceiveURI('bitcoin:bc1qexample?amount=abc')
    expect(Number.isNaN(parsed?.amountBtc as number)).toBe(false)
  })

  it('does not surface a negative or non-finite amount', () => {
    const neg = parseUnifiedReceiveURI('bitcoin:bc1q?amount=-1')
    expect(neg?.amountBtc == null || neg.amountBtc >= 0).toBe(true)
    const inf = parseUnifiedReceiveURI('bitcoin:bc1q?amount=Infinity')
    expect(inf?.amountBtc == null || Number.isFinite(inf.amountBtc)).toBe(true)
  })
})

describe('receiveMethodsOf (S6 — surface methods, do not auto-pay)', () => {
  it('enumerates every present payment method', () => {
    const parsed = parseUnifiedReceiveURI('bitcoin:bc1qexample?lightning=lnbc1pxyz&liquid=lq1qexample')!
    expect(receiveMethodsOf(parsed).sort()).toEqual(['btcAddress', 'lightningInvoice', 'liquidAddress'].sort())
  })

  it('flags multiple methods so the UI can ask rather than guess', () => {
    const parsed = parseUnifiedReceiveURI('bitcoin:bc1qexample?lightning=lnbc1pxyz')!
    expect(receiveMethodsOf(parsed).length).toBeGreaterThan(1)
  })
})
