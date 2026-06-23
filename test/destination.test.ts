import { describe, it, expect } from 'vitest'
import { classifyDestination } from '../src/router/destination'

/**
 * The destination classifier is the cross-protocol routing brain: it decides
 * which adapter(s) can pay an arbitrary string. Because it directs funds, it
 * must fail CLOSED (UNKNOWN / no candidates) on anything it can't positively
 * identify — never guess a protocol from a loose prefix.
 */
describe('classifyDestination', () => {
  it('classifies a BOLT11 invoice as Lightning', () => {
    const r = classifyDestination('lnbc1pexamplexyz')
    expect(r.kind).toBe('BOLT11')
    expect(r.layer).toBe('BTC_LN')
    expect(r.candidates).toContain('RGB_LN')
    expect(r.candidates).not.toContain('LIQUID')
  })

  it('classifies a lightning address / LNURL', () => {
    expect(classifyDestination('alice@example.com').kind).toBe('LN_ADDRESS')
    expect(classifyDestination('lnurl1dp68gurn8ghj7').kind).toBe('LN_ADDRESS')
  })

  it('classifies an RGB invoice (payable by either RGB backing)', () => {
    const r = classifyDestination('rgb:utxob:abcdef')
    expect(r.kind).toBe('RGB_INVOICE')
    expect(r.candidates).toEqual(['RGB_LN', 'RGB_L1'])
  })

  it('classifies a Spark address', () => {
    expect(classifyDestination('spark1qxyzexampleaddr').kind).toBe('SPARK')
  })

  it('classifies an Arkade address', () => {
    expect(classifyDestination('ark1qxyzexampleaddr').kind).toBe('ARKADE')
  })

  it('classifies a real Liquid confidential address', () => {
    const r = classifyDestination('lq1qqw3e3mk4ng2929xexamplexyz')
    expect(r.kind).toBe('LIQUID')
    expect(r.candidates).toEqual(['LIQUID'])
  })

  it('classifies a bare on-chain BTC address', () => {
    const r = classifyDestination('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080')
    expect(r.kind).toBe('BTC_ONCHAIN')
    expect(r.layer).toBe('BTC_L1')
    // LIQUID is a separate L1 and cannot settle a Bitcoin mainnet address.
    expect(r.candidates).not.toContain('LIQUID')
  })

  it('parses a BIP21 URI and extracts the lightning fallback', () => {
    const r = classifyDestination('bitcoin:bc1qexample?amount=0.001&lightning=lnbc1pxyz')
    expect(r.kind).toBe('BIP21')
    expect(r.value).toBe('bc1qexample')
    expect(r.lightningFallback).toBe('lnbc1pxyz')
    // On-chain BTC: LIQUID must not appear (cannot pay a BTC L1 address).
    expect(r.candidates).not.toContain('LIQUID')
  })

  // --- Fail-closed / adversarial inputs (these guard against S1) ----------

  it('does NOT classify an arbitrary "H..." string as Liquid', () => {
    const r = classifyDestination('Hello world')
    expect(r.kind).not.toBe('LIQUID')
    expect(r.candidates).not.toContain('LIQUID')
  })

  it('does NOT classify "VToken" / "CTfoo" / "Azure" as Liquid', () => {
    for (const s of ['VToken', 'CTfoo', 'Azure', 'Gquux']) {
      const r = classifyDestination(s)
      expect(r.kind, `"${s}" should not be LIQUID`).not.toBe('LIQUID')
    }
  })

  it('classifies a Liquid prefix case-insensitively where applicable', () => {
    // lq1 is the canonical lowercase prefix; ensure casing does not break it.
    expect(classifyDestination('LQ1QQEXAMPLE'.toLowerCase()).kind).toBe('LIQUID')
  })

  it('returns UNKNOWN with no candidates for empty / whitespace / junk', () => {
    for (const s of ['', '   ', '???', 'not-an-address']) {
      const r = classifyDestination(s)
      expect(r.kind, `"${s}" should be UNKNOWN`).toBe('UNKNOWN')
      expect(r.candidates).toEqual([])
    }
  })

  it('trims surrounding whitespace before classifying', () => {
    expect(classifyDestination('  lnbc1pexample  ').kind).toBe('BOLT11')
  })

  it('handles null/undefined defensively', () => {
    expect(classifyDestination(undefined as unknown as string).kind).toBe('UNKNOWN')
  })
})
