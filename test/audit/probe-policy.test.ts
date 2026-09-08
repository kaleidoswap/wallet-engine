import { describe, it, expect } from 'vitest'
import { evaluatePolicy, type SigningPolicy } from '../../src/policy'
import { CrossProtocolRouter } from '../../src/router'
import { ProtocolAdapterRegistry, type IProtocolAdapter } from '../../src/adapters/IProtocolAdapter'
import { PROTOCOL_OPERATIONS } from '../../src/capabilities/operations'
import type { ProtocolType } from '../../src/types/base'

function stub(p: ProtocolType): IProtocolAdapter {
  return { protocolName: p, supportedLayers: [], version: 't', capabilities: PROTOCOL_OPERATIONS[p], isConnected: () => true } as unknown as IProtocolAdapter
}
function reg(...ps: ProtocolType[]) { const r = new ProtocolAdapterRegistry(); ps.forEach(p => r.register(stub(p))); return r }

describe('PROBE: policy kind-restriction vs embedded rails', () => {
  const policy: SigningPolicy = {
    mode: 'deny',
    grants: [{ id: 'app1', operations: ['send'], allowedDestinationKinds: ['BIP21'] }],
  }
  const uri = 'bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?lightning=lnbc10u1pATTACKERINVOICE'
  it('a BIP21-only grant passes a URI carrying an LN rail', () => {
    console.log('policy decision:', JSON.stringify(evaluatePolicy({ operation: 'send', destination: uri, amountSat: 1000, grantId: 'app1' }, policy)))
    const router = new CrossProtocolRouter(reg('SPARK', 'RGB_LN', 'ARKADE'))
    const r = router.resolveUnifiedSend(uri)
    console.log('router best:', JSON.stringify(r.best && { p: r.best.protocol, rail: r.best.rail, value: r.best.value, layer: r.best.layer }))
    console.log('all rails:', JSON.stringify(r.routes.map(x => x.rail)))
  })
  it('a bare LN invoice under the same grant is denied', () => {
    console.log('bare bolt11:', JSON.stringify(evaluatePolicy({ operation: 'send', destination: 'lnbc10u1pATTACKERINVOICE', amountSat: 1000, grantId: 'app1' }, policy)))
  })
})

describe('PROBE: policy caps do not cover signing ops', () => {
  const policy: SigningPolicy = { maxAmountSat: 1000 }
  it('signPsbt is uncapped', () => {
    for (const op of ['send','keysend','swap','signPsbt','signLiquidPset','signMessage'] as const) {
      console.log(op, JSON.stringify(evaluatePolicy({ operation: op, amountSat: 99_999_999 } as any, policy)))
    }
  })
})

describe('PROBE: allowlist normalisation', () => {
  const policy: SigningPolicy = { grants: [{ id: 'g', operations: ['send'], destinationAllowlist: ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'] }] }
  it('case / whitespace variants', () => {
    for (const d of ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', ' bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 ', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4']) {
      console.log(JSON.stringify(d), JSON.stringify(evaluatePolicy({ operation: 'send', destination: d, amountSat: 1, grantId: 'g' }, policy)))
    }
  })
})
