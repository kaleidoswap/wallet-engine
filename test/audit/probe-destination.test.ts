import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { classifyDestination } from '../../src/router/destination'
import { buildUnifiedReceiveURI, parseUnifiedReceiveURI } from '../../src/receive/unifiedReceive'

describe('PROBE: bip21 validation asymmetry', () => {
  const junk = ['not-an-address', 'GqXYZ', 'Habc', 'lightning', '0x1234', '💸', 'a'.repeat(200)]
  it('bare junk fails closed; bitcoin:-prefixed junk does not', () => {
    for (const j of junk) {
      const bare = classifyDestination(j)
      const uri = classifyDestination(`bitcoin:${j}`)
      console.log(JSON.stringify({ j, bare: bare.kind, bareCand: bare.candidates.length,
                                   uri: uri.kind, uriCand: uri.candidates.length, uriValue: uri.value }))
    }
  })
  it('bitcoin:<non-btc address> still routed as BTC_L1', () => {
    for (const a of ['lq1qqw508d6qejxtdg4y5r3zarvary0c5xw7k', 'spark1qqqqqqqqqq', 'ark1qqqqqqqqqq', 'lnbc1pvjluezpp5']) {
      const r = classifyDestination(`bitcoin:${a}`)
      console.log(JSON.stringify({ a, kind: r.kind, layer: r.layer, cand: r.candidates, value: r.value }))
    }
  })
})

describe('PROBE: network confusion', () => {
  it('mainnet and testnet destinations classify identically', () => {
    const pairs: [string,string][] = [
      ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'],
      ['spark1qqqqqqqqqqqq', 'sparkt1qqqqqqqqqqqq'],
      ['ark1qqqqqqqqqqqq', 'tark1qqqqqqqqqqqq'],
      ['lq1qqqqqqqqqqqq', 'tlq1qqqqqqqqqqqq'],
      ['lnbc1pvjluez', 'lntb1pvjluez'],
    ]
    for (const [m, t] of pairs) {
      const rm = classifyDestination(m), rt = classifyDestination(t)
      console.log(JSON.stringify({ m: rm.kind, t: rt.kind, sameKind: rm.kind===rt.kind,
                                   sameLayer: rm.layer===rt.layer, sameCand: JSON.stringify(rm.candidates)===JSON.stringify(rt.candidates) }))
    }
  })
})

describe('PROBE: unified receive round-trip', () => {
  it('build -> parse round-trips', () => {
    let counterexample: any = null
    try {
      fc.assert(
        fc.property(
          fc.record({
            btcAddress: fc.option(fc.constantFrom('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4','tb1qxyz'), {nil: undefined}),
            lightningInvoice: fc.option(fc.constantFrom('lnbc1pvjluezpp5'), {nil: undefined}),
            label: fc.option(fc.string(), {nil: undefined}),
            amountBtc: fc.option(fc.double({min: 0.00000001, max: 1000, noNaN: true}), {nil: undefined}),
          }),
          (p: any) => {
            if (!p.btcAddress && !p.lightningInvoice) return true
            const uri = buildUnifiedReceiveURI(p)
            const back = parseUnifiedReceiveURI(uri)
            expect(back).not.toBeNull()
            expect(back!.btcAddress).toBe(p.btcAddress)
            expect(back!.lightningInvoice).toBe(p.lightningInvoice)
            if (p.label) expect(back!.label).toBe(p.label)
            return true
          },
        ), { numRuns: 3000, seed: 424242 },
      )
    } catch (e: any) { counterexample = e.message }
    console.log('ROUNDTRIP:', counterexample ?? 'no counterexample')
  })

  it('btcAddress is not URI-encoded on build (injection probe)', () => {
    const uri = buildUnifiedReceiveURI({ btcAddress: 'bc1qGOOD?lightning=lnbcATTACKER', amountBtc: 0.001 })
    console.log('URI:', uri)
    console.log('PARSED:', JSON.stringify(parseUnifiedReceiveURI(uri)))
  })

  it('amount edge values', () => {
    for (const a of [1e21, 1e-9, 0.000000015, 21_000_000, 1e20]) {
      try { console.log(a, '->', buildUnifiedReceiveURI({ btcAddress: 'bc1qx', amountBtc: a })) }
      catch (e: any) { console.log(a, 'THREW', e.message) }
    }
    for (const s of ['1e300','0','-0','0.1e1','  5  ','Infinity','1e-400','0x10']) {
      console.log(`amount=${s} ->`, JSON.stringify(parseUnifiedReceiveURI(`bitcoin:bc1qx?amount=${encodeURIComponent(s)}`)?.amountBtc))
    }
  })
})
