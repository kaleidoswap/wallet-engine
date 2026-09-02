import { describe, it, expect } from 'vitest'
import { classifyDestination } from '../../src/router/destination'
import { CrossProtocolRouter } from '../../src/router'
import { ProtocolAdapterRegistry, type IProtocolAdapter } from '../../src/adapters/IProtocolAdapter'
import { PROTOCOL_OPERATIONS } from '../../src/capabilities/operations'
import type { ProtocolType } from '../../src/types/base'

/**
 * Audit finding O1 — the BIP21 branch of `classifyDestination` returned a payable
 * BTC_L1 route for ANY text after `bitcoin:`, without validating it as a Bitcoin
 * address. That contradicts the module's own fail-closed contract and let
 * `resolveSend` hand lite mode a "direct" route to junk — or to a Liquid address,
 * which is a cross-chain misroute. `resolveUnifiedSend` already handled the same
 * input correctly, so the two entry points disagreed.
 */

function stub(p: ProtocolType): IProtocolAdapter {
  return { protocolName: p, supportedLayers: [], version: 't', capabilities: PROTOCOL_OPERATIONS[p], isConnected: () => true } as unknown as IProtocolAdapter
}
function reg(...ps: ProtocolType[]) { const r = new ProtocolAdapterRegistry(); ps.forEach(p => r.register(stub(p))); return r }

describe('O1: bitcoin: URIs must validate their address like bare destinations do', () => {
  const junk = ['not-an-address', 'GqXYZ', 'Habc', 'lightning', '0x1234', '💸', 'a'.repeat(200)]

  it('bitcoin:<junk> fails closed, exactly like bare <junk>', () => {
    for (const j of junk) {
      const bare = classifyDestination(j)
      const uri = classifyDestination(`bitcoin:${j}`)
      expect(bare.kind, `bare ${j}`).toBe('UNKNOWN')
      expect(uri.candidates, `bitcoin:${j} must have no candidates`).toEqual([])
      expect(uri.layer, `bitcoin:${j} must have no layer`).toBeNull()
    }
  })

  it('a non-BTC address inside a bitcoin: URI is never routed as BTC_L1', () => {
    for (const a of ['lq1qqw508d6qejxtdg4y5r3zarvary0c5xw7k', 'spark1qqqqqqqqqq', 'ark1qqqqqqqqqq']) {
      const r = classifyDestination(`bitcoin:${a}`)
      expect(r.candidates, `bitcoin:${a}`).toEqual([])
    }
  })

  it('resolveSend gives no auto-route for bitcoin:<junk>', () => {
    const router = new CrossProtocolRouter(reg('SPARK', 'RGB_LN', 'ARKADE', 'LIQUID'))
    for (const j of [...junk, 'lq1qqw508d6qejxtdg4y5r3zarvary0c5xw7k']) {
      const r = router.resolveSend(`bitcoin:${j}`)
      expect(r.best, `bitcoin:${j} must not auto-route`).toBeNull()
      expect(r.routes, `bitcoin:${j} must have no routes`).toEqual([])
    }
  })

  it('neither entry point ever routes a non-BTC address as an on-chain BTC send', () => {
    const router = new CrossProtocolRouter(reg('SPARK', 'RGB_LN', 'ARKADE', 'LIQUID'))
    // `resolveSend` fails closed. `resolveUnifiedSend` re-classifies each rail and
    // may legitimately do better (a Liquid address routes to LIQUID) — what neither
    // may do is claim BTC_L1 for an address that is not a Bitcoin address.
    for (const d of ['bitcoin:not-an-address', 'bitcoin:lq1qqw508d6qejxtdg4y5r3zarvary0c5xw7k']) {
      expect(router.resolveSend(d).best, d).toBeNull()
      const uni = router.resolveUnifiedSend(d).best
      if (uni) expect(uni.layer, d).not.toBe('BTC_L1')
    }
  })

  // A VALID address in a bitcoin: URI must keep working exactly as before.
  it('valid bitcoin: URIs still route', () => {
    const router = new CrossProtocolRouter(reg('SPARK', 'RGB_LN'))
    const r = router.resolveSend('bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.001')
    expect(r.destination.kind).toBe('BIP21')
    expect(r.destination.value).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
    expect(r.best?.direct).toBe(true)
    const legacy = classifyDestination('bitcoin:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')
    expect(legacy.kind).toBe('BIP21')
    expect(legacy.candidates.length).toBeGreaterThan(0)
  })

  it('an address-less bitcoin:?lightning=… URI still surfaces the fallback', () => {
    const r = classifyDestination('bitcoin:?lightning=lnbc1pvjluez')
    expect(r.kind).toBe('BIP21')
    expect(r.candidates).toEqual([])
    expect(r.lightningFallback).toBe('lnbc1pvjluez')
  })
})
