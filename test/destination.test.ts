import { describe, it, expect } from 'vitest'
import { bech32m } from '@scure/base'
import { classifyDestination, sparkAddressNetwork } from '../src/router/destination'
import { sparkAddress, testPubkey } from './fixtures/spark-address'

/**
 * The destination classifier decides which adapter(s) can pay an arbitrary string.
 * Because it directs funds it must fail CLOSED (UNKNOWN / no candidates) on anything
 * it can't positively identify — never guessing from a loose prefix.
 */
describe('classifyDestination', () => {
  it('classifies a BOLT11 invoice as Lightning', () => {
    const r = classifyDestination('lnbc1pexamplexyz')
    expect(r.kind).toBe('BOLT11')
    expect(r.layer).toBe('BTC_LN')
    expect(r.candidates).toContain('RGB_LN')
    expect(r.candidates).not.toContain('LIQUID')
  })

  it('classifies signet/testnet/regtest BOLT11 invoices as Lightning', () => {
    // `lntbs…` is the signet HRP (the project's active network); the `tbs`
    // alternative must win over `tb` so the trailing digit check still passes.
    for (const inv of ['lntbs1pexample', 'lntb1pexample', 'lnbcrt1pexample']) {
      expect(classifyDestination(inv).kind, `${inv} should be BOLT11`).toBe('BOLT11')
    }
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
    const r = classifyDestination(sparkAddress('spark'))
    expect(r.kind).toBe('SPARK')
    expect(r.sparkNetwork).toBe('MAINNET')
  })

  it('maps every spark-sdk HRP (current + legacy) to its network', () => {
    const expected: Array<[string, string]> = [
      ['spark', 'MAINNET'], ['sp', 'MAINNET'],
      ['sparkt', 'TESTNET'], ['spt', 'TESTNET'],
      ['sparkrt', 'REGTEST'], ['sprt', 'REGTEST'],
      ['sparks', 'SIGNET'], ['sps', 'SIGNET'],
      ['sparkl', 'LOCAL'], ['spl', 'LOCAL'],
    ]
    for (const [hrp, network] of expected) {
      const r = classifyDestination(sparkAddress(hrp))
      expect(r.kind, `${hrp}1… should be SPARK`).toBe('SPARK')
      expect(r.sparkNetwork, `${hrp}1… network`).toBe(network)
    }
  })

  it('accepts an all-uppercase Spark address (bech32m allows it, e.g. QR alphanumeric)', () => {
    expect(classifyDestination(sparkAddress('sparkrt').toUpperCase()).kind).toBe('SPARK')
  })

  it('rejects a Spark address with one extra character (checksum)', () => {
    const valid = sparkAddress('sparkrt')
    for (const tampered of [`${valid}q`, `${valid.slice(0, 20)}q${valid.slice(20)}`]) {
      expect(classifyDestination(tampered).kind).toBe('UNKNOWN')
      expect(sparkAddressNetwork(tampered)).toBeNull()
    }
  })

  it('rejects a Spark address with one character changed or dropped', () => {
    const valid = sparkAddress('spark')
    const flipped = valid.slice(0, -1) + (valid.endsWith('q') ? 'p' : 'q')
    expect(classifyDestination(flipped).kind).toBe('UNKNOWN')
    expect(classifyDestination(valid.slice(0, -1)).kind).toBe('UNKNOWN')
  })

  it('rejects mixed case and non-bech32 characters', () => {
    const valid = sparkAddress('spark')
    expect(classifyDestination(valid.slice(0, 10) + valid.slice(10).toUpperCase()).kind).toBe('UNKNOWN')
    expect(classifyDestination(`${valid.slice(0, 12)}b${valid.slice(13)}`).kind).toBe('UNKNOWN')
  })

  it('rejects regex-shaped Spark strings with no valid checksum', () => {
    for (const addr of ['spark1qxyzexampleaddr', 'sparkrt1qqqqqqqqqq', 'sparks1qqqqqqqqqqqq', 'spt1qqqqqqqqqqqq']) {
      expect(classifyDestination(addr).kind, addr).toBe('UNKNOWN')
    }
  })

  it('rejects a checksum-valid bech32m string with a Spark HRP but a non-Spark payload', () => {
    const notAPubkey = bech32m.encode('spark', bech32m.toWords(Uint8Array.from([0x0a, 0x21, ...new Uint8Array(33)])))
    expect(classifyDestination(notAPubkey).kind).toBe('UNKNOWN')
    const wrongTag = bech32m.encode('spark', bech32m.toWords(new Uint8Array(40).fill(7)))
    expect(classifyDestination(wrongTag).kind).toBe('UNKNOWN')
  })

  it('rejects a checksum-valid Spark payload under a non-Spark HRP', () => {
    const payload = bech32m.decode(sparkAddress('spark') as `${string}1${string}`, 1024).words
    expect(classifyDestination(bech32m.encode('sparkx', payload, 1024)).kind).toBe('UNKNOWN')
  })

  it('does NOT classify a Silent Payments (sp1…) address as Spark', () => {
    // BIP352 Silent Payment addresses share the `sp1` HRP; misrouting one as a
    // Spark transfer would lose funds. It must fail closed.
    const r = classifyDestination('sp1qqw508d6qejxtdg4y5r3zarvary0c5xw7kexample')
    expect(r.kind).not.toBe('SPARK')
  })

  it('does NOT classify a checksum-valid Silent Payments address as legacy Spark `sp1`', () => {
    // BIP352: version word 0, then scan + spend pubkeys (66 bytes).
    const words = [0, ...bech32m.toWords(Uint8Array.from([...testPubkey(2), ...testPubkey(3)]))]
    const silentPayment = bech32m.encode('sp', words, 1023)
    expect(silentPayment.startsWith('sp1q')).toBe(true)
    expect(classifyDestination(silentPayment).kind).toBe('UNKNOWN')
  })

  it('classifies an Arkade address', () => {
    expect(classifyDestination('ark1qxyzexampleaddr').kind).toBe('ARKADE')
  })

  it('classifies a real Liquid confidential address', () => {
    const r = classifyDestination('lq1qqw3e3mk4ng2929xexamplexyz')
    expect(r.kind).toBe('LIQUID')
    expect(r.candidates).toEqual(['LIQUID'])
  })

  it('classifies a legacy base58 CONFIDENTIAL Liquid address (VJL… mainnet)', () => {
    // Real mainnet confidential P2SH address (version byte 12, 55-byte payload).
    const r = classifyDestination(
      'VJLAaiCkHJAKmwGEhN97gs4a2LPUBKapCbGuHxoQm2rxj8c7VTgoQPVdSYdm96ZGCBvtFFKtrA3mS3Rv',
    )
    expect(r.kind).toBe('LIQUID')
    expect(r.candidates).toEqual(['LIQUID'])
  })

  it('does NOT classify an unconfidential base58 Liquid / BTC address as LIQUID', () => {
    // A legacy base58 BTC address decodes to a 21-byte payload — it must not be
    // mistaken for a confidential Liquid address (which is 55 bytes).
    const r = classifyDestination('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')
    expect(r.kind).not.toBe('LIQUID')
    expect(r.candidates).not.toContain('LIQUID')
  })

  it('fails closed on a VJL-prefixed string with a bad base58check checksum', () => {
    // Same address with its last char mangled — checksum fails, so it must NOT
    // be routed to Liquid.
    const r = classifyDestination(
      'VJLAaiCkHJAKmwGEhN97gs4a2LPUBKapCbGuHxoQm2rxj8c7VTgoQPVdSYdm96ZGCBvtFFKtrA3mS3Rx',
    )
    expect(r.kind).not.toBe('LIQUID')
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

  it('fails closed on an address-less BIP21 URI (no bogus empty-address route)', () => {
    // `bitcoin:?lightning=…` carries no on-chain address; it must NOT yield a
    // direct on-chain route whose payable value is the empty string.
    const r = classifyDestination('bitcoin:?lightning=lnbc1pxyz&spark=spark1qxyz')
    expect(r.kind).toBe('BIP21')
    expect(r.value).toBe('')
    expect(r.candidates).toEqual([])
    expect(r.layer).toBeNull()
    // The embedded lightning fallback is still surfaced for explicit routing.
    expect(r.lightningFallback).toBe('lnbc1pxyz')
  })

  it('does not throw on malformed percent-encoding in lightning= (hostile QR)', () => {
    const r = classifyDestination('bitcoin:bc1qexample?lightning=%E0%A4%A')
    expect(r.kind).toBe('BIP21')
    expect(r.value).toBe('bc1qexample')
    // undecodable parameter is treated as absent, not a crash
    expect(r.lightningFallback).toBeUndefined()
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
