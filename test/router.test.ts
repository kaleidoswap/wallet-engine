import { describe, it, expect } from 'vitest'
import { CrossProtocolRouter } from '../src/router'
import { ProtocolAdapterRegistry, type IProtocolAdapter } from '../src/adapters/IProtocolAdapter'
import { PROTOCOL_OPERATIONS } from '../src/capabilities/operations'
import type { ProtocolType } from '../src/types/base'

/** A minimal connected adapter stub for routing tests. */
function stubAdapter(protocol: ProtocolType): IProtocolAdapter {
  return {
    protocolName: protocol,
    supportedLayers: [],
    version: 'test',
    capabilities: PROTOCOL_OPERATIONS[protocol],
    isConnected: () => true,
  } as unknown as IProtocolAdapter
}

function registryWith(...protocols: ProtocolType[]): ProtocolAdapterRegistry {
  const r = new ProtocolAdapterRegistry()
  for (const p of protocols) r.register(stubAdapter(p))
  return r
}

describe('CrossProtocolRouter.resolveSend', () => {
  it('routes a BOLT11 invoice to a connected LN-capable protocol', () => {
    const router = new CrossProtocolRouter(registryWith('RGB_LN', 'LIQUID'))
    const res = router.resolveSend('lnbc1pexample')
    expect(res.best?.protocol).toBe('RGB_LN')
    expect(res.best?.direct).toBe(true)
    // LIQUID has no Lightning → must not be a candidate at all.
    expect(res.routes.map((r) => r.protocol)).not.toContain('LIQUID')
  })

  it('returns no route when no candidate protocol is connected', () => {
    const router = new CrossProtocolRouter(registryWith('LIQUID'))
    const res = router.resolveSend('lnbc1pexample') // only RGB/SPARK/ARKADE can pay LN
    expect(res.best).toBeNull()
    expect(res.routes).toEqual([])
  })

  it('marks `direct` from the capability manifest, not unconditionally', () => {
    // RGB supports on-chain → direct true for a bare BTC address.
    const router = new CrossProtocolRouter(registryWith('RGB_LN'))
    const res = router.resolveSend('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080')
    const rgb = res.routes.find((r) => r.protocol === 'RGB_LN')
    expect(rgb?.direct).toBe(true)
  })

  it('routes an RGB invoice only to RGB', () => {
    const router = new CrossProtocolRouter(registryWith('RGB_LN', 'SPARK'))
    const res = router.resolveSend('rgb:utxob:abc')
    expect(res.best?.protocol).toBe('RGB_LN')
    expect(res.routes).toHaveLength(1)
  })

  it('best is always a directly-payable route', () => {
    const router = new CrossProtocolRouter(registryWith('RGB_LN', 'SPARK', 'ARKADE'))
    const res = router.resolveSend('lnbc1pexample')
    expect(res.best).not.toBeNull()
    expect(res.best?.direct).toBe(true)
  })
})
