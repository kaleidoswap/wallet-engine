import { describe, it, expect } from 'vitest'
import { evaluatePolicy, type SigningPolicy } from '../../src/policy'

/**
 * Audit finding O2 — a capability grant scoped by `allowedDestinationKinds`
 * classified only the OUTER destination string. A BIP321 URI classifies as
 * `BIP21`, but it can carry `lightning=`/`lno=`/`spark=`/`ark=`/`liquid=`/`rgb=`
 * rails that the router will happily pay — and ranks Lightning FIRST. So a grant
 * that permitted only `BIP21` executed an attacker-chosen Lightning invoice,
 * while the same invoice pasted bare was correctly denied.
 */
const bip21Only: SigningPolicy = {
  mode: 'deny',
  grants: [{ id: 'app1', operations: ['send'], allowedDestinationKinds: ['BIP21'] }],
}
const ask = (destination: string, policy = bip21Only) =>
  evaluatePolicy({ operation: 'send', destination, amountSat: 1000, grantId: 'app1' }, policy)

describe('O2: kind restrictions must cover every rail a URI carries', () => {
  it('a BIP21-only grant does not pass a URI carrying a Lightning rail', () => {
    const d = ask('bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?lightning=lnbc10u1pATTACKER')
    expect(d.allowed, 'the embedded BOLT11 is not a BIP21 destination').toBe(false)
  })

  it('every embedded rail kind is checked, not just lightning=', () => {
    for (const rail of [
      'lno=lno1attackeroffer',
      'spark=spark1qqqqqqqqqqqq',
      'ark=ark1qqqqqqqqqqqq',
      'liquid=lq1qqqqqqqqqqqq',
      'rgb=rgb:someasset',
    ]) {
      const d = ask(`bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?${rail}`)
      expect(d.allowed, rail).toBe(false)
    }
  })

  it('the bare form of the same invoice is still denied (unchanged)', () => {
    expect(ask('lnbc10u1pATTACKER').allowed).toBe(false)
  })

  it('a plain bitcoin: URI with no extra rails is still allowed', () => {
    expect(ask('bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.001').allowed).toBe(true)
    expect(ask('bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?label=coffee').allowed).toBe(true)
  })

  it('a grant that DOES cover the embedded rail still permits it', () => {
    const both: SigningPolicy = {
      mode: 'deny',
      grants: [{ id: 'app1', operations: ['send'], allowedDestinationKinds: ['BIP21', 'BOLT11'] }],
    }
    expect(ask('bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?lightning=lnbc10u1pOK', both).allowed).toBe(true)
  })

  it('grants with no kind restriction are unaffected', () => {
    const open: SigningPolicy = { mode: 'deny', grants: [{ id: 'app1', operations: ['send'] }] }
    expect(ask('bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?lightning=lnbc1x', open).allowed).toBe(true)
  })
})
