import { describe, it, expect } from 'vitest'
import { CrossProtocolRouter } from '../../src/router'
import { ProtocolAdapterRegistry, type IProtocolAdapter } from '../../src/adapters/IProtocolAdapter'
import { PROTOCOL_OPERATIONS } from '../../src/capabilities/operations'
import type { ProtocolType } from '../../src/types/base'

function stubAdapter(protocol: ProtocolType): IProtocolAdapter {
  return { protocolName: protocol, supportedLayers: [], version: 'test',
    capabilities: PROTOCOL_OPERATIONS[protocol], isConnected: () => true } as unknown as IProtocolAdapter
}
function registryWith(...ps: ProtocolType[]) {
  const r = new ProtocolAdapterRegistry(); for (const p of ps) r.register(stubAdapter(p)); return r
}

describe('PROBE: does bitcoin:<junk> produce a payable best route?', () => {
  const router = new CrossProtocolRouter(registryWith('SPARK', 'RGB_LN', 'ARKADE', 'LIQUID'))
  it('resolveSend', () => {
    for (const d of ['not-an-address', 'bitcoin:not-an-address', 'bitcoin:lq1qqw508d6qejxtdg4y5r3zarvary0c5xw7k', 'bitcoin:💸', 'bitcoin:']) {
      const r = router.resolveSend(d)
      console.log(JSON.stringify({ d, kind: r.destination.kind, best: r.best?.protocol ?? null,
        direct: r.best?.direct ?? null, value: r.destination.value, nRoutes: r.routes.length }))
    }
  })
  it('resolveUnifiedSend', () => {
    for (const d of ['bitcoin:not-an-address?amount=0.5', 'bitcoin:lq1qqw508d6qejxtdg4y5r3zarvary0c5xw7k']) {
      const r = router.resolveUnifiedSend(d)
      console.log(JSON.stringify({ d, best: r.best ? {p: r.best.protocol, rail: r.best.rail, value: r.best.value, direct: r.best.direct} : null }))
    }
  })
  it('rail mislabelling: a lightning invoice smuggled into the spark= param', () => {
    const r = router.resolveUnifiedSend('bitcoin:?spark=lnbc1pvjluezpp5xyz')
    console.log('spark-rail:', JSON.stringify(r.routes.map(x => ({p: x.protocol, rail: x.rail, layer: x.layer, direct: x.direct, v: x.value}))))
  })
})
