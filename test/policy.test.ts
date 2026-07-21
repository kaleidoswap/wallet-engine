import { describe, it, expect } from 'vitest'
import { evaluatePolicy, enforcePolicy, PolicyError, type SigningPolicy } from '../src/policy'

describe('evaluatePolicy — default-allow', () => {
  it('allows anything when the policy is empty', () => {
    expect(evaluatePolicy({ operation: 'send', amountSat: 1e9 }, {}).allowed).toBe(true)
  })

  it('enforces a global per-tx cap on amount ops only', () => {
    const p: SigningPolicy = { maxAmountSat: 1000 }
    expect(evaluatePolicy({ operation: 'send', amountSat: 1000 }, p).allowed).toBe(true)
    const over = evaluatePolicy({ operation: 'send', amountSat: 1001 }, p)
    expect(over.allowed).toBe(false)
    expect(over).toMatchObject({ code: 'AMOUNT_OVER_GLOBAL_LIMIT' })
    // signMessage carries no amount → never capped
    expect(evaluatePolicy({ operation: 'signMessage' }, p).allowed).toBe(true)
  })

  it('fails CLOSED when a global cap is set but an amount-op amount is unknown', () => {
    const p: SigningPolicy = { maxAmountSat: 1000 }
    // amount-op with no amountSat (e.g. amountless BOLT11) → denied, not skipped
    expect(evaluatePolicy({ operation: 'send' }, p)).toMatchObject({
      allowed: false,
      code: 'AMOUNT_UNKNOWN',
    })
    expect(evaluatePolicy({ operation: 'swap' }, p)).toMatchObject({ code: 'AMOUNT_UNKNOWN' })
    // non-amount ops are unaffected by the cap
    expect(evaluatePolicy({ operation: 'signMessage' }, p).allowed).toBe(true)
  })

  it('allows an unknown amount when NO cap is configured', () => {
    expect(evaluatePolicy({ operation: 'send' }, {}).allowed).toBe(true)
    expect(evaluatePolicy({ operation: 'send' }, { mode: 'allow' }).allowed).toBe(true)
  })
})

describe('evaluatePolicy — default-deny', () => {
  const policy: SigningPolicy = {
    mode: 'deny',
    grants: [
      {
        id: 'dapp-A',
        operations: ['send'],
        protocols: ['SPARK'],
        maxAmountSat: 5000,
        allowedDestinationKinds: ['BOLT11'],
      },
    ],
  }

  it('denies when no grant is provided', () => {
    expect(evaluatePolicy({ operation: 'send', amountSat: 1 }, policy)).toMatchObject({
      allowed: false,
      code: 'NO_GRANT',
    })
  })

  it('denies an unknown grant id', () => {
    expect(evaluatePolicy({ operation: 'send', grantId: 'ghost' }, policy)).toMatchObject({
      allowed: false,
      code: 'GRANT_NOT_FOUND',
    })
  })

  it('denies an operation the grant does not include', () => {
    expect(evaluatePolicy({ operation: 'swap', grantId: 'dapp-A' }, policy)).toMatchObject({
      code: 'OP_NOT_GRANTED',
    })
  })

  it('denies a protocol the grant does not include', () => {
    expect(
      evaluatePolicy({ operation: 'send', grantId: 'dapp-A', protocol: 'LIQUID' }, policy),
    ).toMatchObject({ code: 'PROTOCOL_NOT_GRANTED' })
  })

  it('enforces the grant amount cap', () => {
    expect(
      evaluatePolicy({ operation: 'send', grantId: 'dapp-A', protocol: 'SPARK', amountSat: 5001 }, policy),
    ).toMatchObject({ code: 'AMOUNT_OVER_GRANT_LIMIT' })
  })

  it('fails CLOSED when a grant cap is set but the amount is unknown', () => {
    expect(
      evaluatePolicy({ operation: 'send', grantId: 'dapp-A', protocol: 'SPARK' }, policy),
    ).toMatchObject({ allowed: false, code: 'AMOUNT_UNKNOWN' })
  })

  it('enforces the destination-kind allowlist', () => {
    // an on-chain BTC address is not BOLT11 → denied
    const r = evaluatePolicy(
      { operation: 'send', grantId: 'dapp-A', protocol: 'SPARK', amountSat: 10, destination: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' },
      policy,
    )
    expect(r).toMatchObject({ code: 'DEST_KIND_NOT_ALLOWED' })
  })

  it('allows a fully-compliant request', () => {
    const r = evaluatePolicy(
      { operation: 'send', grantId: 'dapp-A', protocol: 'SPARK', amountSat: 5000, destination: 'lnbc1abcdef' },
      policy,
    )
    expect(r.allowed).toBe(true)
  })

  it('enforces an exact destination allowlist', () => {
    const p: SigningPolicy = {
      mode: 'deny',
      grants: [{ id: 'g', operations: ['send'], destinationAllowlist: ['lnbc1known'] }],
    }
    expect(evaluatePolicy({ operation: 'send', grantId: 'g', destination: 'lnbc1known' }, p).allowed).toBe(true)
    expect(evaluatePolicy({ operation: 'send', grantId: 'g', destination: 'lnbc1other' }, p)).toMatchObject({
      code: 'DEST_NOT_ALLOWLISTED',
    })
  })
})

describe('enforcePolicy', () => {
  it('is a no-op when no policy is set', () => {
    expect(() => enforcePolicy({ operation: 'send', amountSat: 1e9 })).not.toThrow()
  })

  it('throws PolicyError with the decision code on denial', () => {
    try {
      enforcePolicy({ operation: 'send', amountSat: 2 }, { maxAmountSat: 1 })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyError)
      expect((e as PolicyError).code).toBe('AMOUNT_OVER_GLOBAL_LIMIT')
    }
  })
})
