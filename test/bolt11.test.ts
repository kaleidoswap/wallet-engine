import { describe, it, expect } from 'vitest'
import { decodeBolt11, isBolt11 } from '../src/lib/bolt11'

describe('decodeBolt11', () => {
  it('returns network with no amount for an amountless invoice', () => {
    const r = decodeBolt11('lnbc1pexampleamountless')
    expect(r.network).toBe('bc')
    expect(r.amountSat).toBeUndefined()
  })

  it('decodes the milli/micro/nano/pico multipliers', () => {
    // 1m BTC = 0.001 BTC = 100_000 sat
    expect(decodeBolt11('lnbc1m1pexample').amountSat).toBe(100_000)
    // 2500u BTC = 0.0025 BTC = 250_000 sat
    expect(decodeBolt11('lnbc2500u1pexample').amountSat).toBe(250_000)
    // 1500n BTC = 0.0000015 BTC = 150 sat
    expect(decodeBolt11('lnbc1500n1pexample').amountSat).toBe(150)
    // 1000000p BTC = 0.00000001 BTC * ... → rounds to 100 sat
    expect(decodeBolt11('lnbc1000000p1pexample').amountSat).toBe(100)
  })

  it('treats a bare digit amount with no multiplier as whole BTC', () => {
    // lnbc1<sep>... is amountless (the 1 is the bech32 separator), so use 2.
    expect(decodeBolt11('lnbc21pexample').amountSat).toBe(2 * 1e8)
  })

  it('detects testnet / signet / regtest networks', () => {
    expect(decodeBolt11('lntb1pexample').network).toBe('tb')
    expect(decodeBolt11('lntbs1pexample').network).toBe('tbs')
    expect(decodeBolt11('lnbcrt1pexample').network).toBe('bcrt')
  })

  it('returns network "unknown" for a non-BOLT11 string', () => {
    expect(decodeBolt11('bc1qexample').network).toBe('unknown')
    expect(decodeBolt11('').network).toBe('unknown')
  })
})

describe('isBolt11', () => {
  it('is true for LN invoices across networks, false otherwise', () => {
    expect(isBolt11('lnbc1pxyz')).toBe(true)
    expect(isBolt11('LNTB1PXYZ')).toBe(true)
    expect(isBolt11('  lnbcrt1pxyz  ')).toBe(true)
    expect(isBolt11('bc1qxyz')).toBe(false)
    expect(isBolt11('')).toBe(false)
  })
})
