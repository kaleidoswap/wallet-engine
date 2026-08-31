/*
 * Regression test for audit finding B-F5 (REPORT.md §2.2, REPORT-2.md §4.2).
 *
 * `CrossProtocolRouter` certified a BOLT12 offer (`lno1…`) as `direct: true` for
 * RGB_LN, SPARK and ARKADE, because `canSettleDirectly` read `supportsLightning`
 * for the BOLT12 case. Paying an OFFER is a different capability from paying an
 * invoice, and no adapter in this package has it:
 *
 *   RGB_LN (native + WDK) — the string is passed verbatim as `invoice` to the
 *     RLN node; `SendPaymentRequest` has one bolt11-shaped `invoice` field and no
 *     offer field at all.
 *   SPARK (native)        — the `startsWith("ln")` gate MATCHES `lno1…` and
 *     forwards it to `payLightningInvoice`, which is documented BOLT11-only.
 *   SPARK (WDK)           — the `isBolt11` gate excludes it, so it degrades to
 *     the ON-CHAIN withdrawal path.
 *   ARKADE (both)         — the invoice matcher excludes `lno1…`, so the offer
 *     string falls through to `sendBitcoin({ address: <the offer> })`.
 *
 * So `best` — the route lite mode auto-pays — was a route guaranteed to fail or,
 * on three of those six paths, to send funds on the WRONG RAIL to a string that
 * is not an address.
 *
 * `direct` is now gated on an explicit `supportsBolt12` capability, which no
 * manifest sets. The flag exists rather than a hardcoded `false` so the router
 * keeps reading the manifest (its stated policy) and a future adapter with a real
 * offer flow has exactly one switch to flip.
 */
import { describe, expect, it } from 'vitest'
import { CrossProtocolRouter } from '../../src/router'
import { ProtocolAdapterRegistry, type IProtocolAdapter } from '../../src/adapters/IProtocolAdapter'
import { getCapabilities, PROTOCOL_CAPABILITIES } from '../../src/capabilities'
import { PROTOCOL_OPERATIONS } from '../../src/capabilities/operations'
import type { ProtocolType } from '../../src/types/base'

const OFFER = 'lno1pgexampleofferxyz'
const BOLT11 = 'lnbc1pexampleinvoice'

function stub(protocol: ProtocolType): IProtocolAdapter {
  return {
    protocolName: protocol,
    supportedLayers: [],
    version: 'test',
    capabilities: PROTOCOL_OPERATIONS[protocol],
    isConnected: () => true,
  } as unknown as IProtocolAdapter
}
function routerWith(...protocols: ProtocolType[]) {
  const reg = new ProtocolAdapterRegistry()
  for (const p of protocols) reg.register(stub(p))
  return new CrossProtocolRouter(reg)
}

describe('B-F5: a BOLT12 offer is never certified as directly payable', () => {
  it('no protocol claims a direct BOLT12 route', () => {
    const res = routerWith('RGB_LN', 'SPARK', 'ARKADE').resolveSend(OFFER)
    expect(res.destination.kind).toBe('BOLT12')
    // The offer is still classified and routed — it is only the DIRECT claim
    // that was false. An advanced-mode UI can still show these.
    expect(res.routes.length).toBeGreaterThan(0)
    for (const route of res.routes) {
      expect(route.direct, `${route.protocol} must not claim it can pay an offer`).toBe(false)
    }
  })

  it('lite mode auto-selects nothing for a bare offer', () => {
    // `best` is documented as "the auto-selected route for lite mode (first
    // direct route), or null". Null is the honest answer here.
    expect(routerWith('RGB_LN', 'SPARK', 'ARKADE').resolveSend(OFFER).best).toBeNull()
  })

  it('BOLT11 and LN addresses are unaffected — this is not a Lightning-wide change', () => {
    const bolt11 = routerWith('RGB_LN', 'SPARK', 'ARKADE').resolveSend(BOLT11)
    expect(bolt11.best?.direct).toBe(true)
    const lnAddr = routerWith('RGB_LN', 'SPARK', 'ARKADE').resolveSend('alice@example.com')
    expect(lnAddr.destination.kind).toBe('LN_ADDRESS')
    expect(lnAddr.best?.direct).toBe(true)
  })

  it('a multi-rail URI falls through to a rail that IS payable', () => {
    const uri =
      `bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080?amount=0.001` +
      `&lightning=${BOLT11}&lno=${OFFER}`
    const res = routerWith('RGB_LN').resolveUnifiedSend(uri)
    // Lightning-first is preserved; it just skips the rail nobody can settle.
    expect(res.best?.rail).toBe('lightning')
    expect(res.routes.find((r) => r.rail === 'lno')?.direct).toBe(false)
  })

  it('the offer rail alone leaves lite mode on the merchant\'s on-chain address', () => {
    const uri = `bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080?amount=0.001&lno=${OFFER}`
    expect(routerWith('RGB_LN').resolveUnifiedSend(uri).best?.rail).toBe('onchain')
  })

  it('no capability manifest claims BOLT12 support', () => {
    // The invariant that makes every assertion above hold. If someone flips one
    // of these, THIS is the test that should make them prove the adapter can
    // actually pay an offer.
    for (const protocol of Object.keys(PROTOCOL_CAPABILITIES) as ProtocolType[]) {
      expect(
        getCapabilities(protocol).supportsBolt12,
        `${protocol} claims BOLT12 support — does its send path really handle lno1…?`,
      ).toBe(false)
    }
  })

  it('supportsBolt12 is what gates it, not a hardcoded false', () => {
    // Prove the router reads the manifest: with the flag on, the route is direct
    // again. This is the switch a future offer-capable adapter flips.
    const caps = getCapabilities('RGB_LN')
    const original = caps.supportsBolt12
    try {
      ;(caps as { supportsBolt12: boolean }).supportsBolt12 = true
      expect(routerWith('RGB_LN').resolveSend(OFFER).best?.direct).toBe(true)
    } finally {
      ;(caps as { supportsBolt12: boolean }).supportsBolt12 = original
    }
  })
})
