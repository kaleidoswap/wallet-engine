import { describe, expect, it } from 'vitest'
import { CrossProtocolRouter } from '../../src/router'
import { ProtocolAdapterRegistry, type IProtocolAdapter } from '../../src/adapters/IProtocolAdapter'
import { PROTOCOL_OPERATIONS } from '../../src/capabilities/operations'

function router(): CrossProtocolRouter {
  const registry = new ProtocolAdapterRegistry()
  registry.register({
    protocolName: 'RGB_LN',
    supportedLayers: [],
    version: 'test',
    capabilities: PROTOCOL_OPERATIONS.RGB_LN,
    isConnected: () => true,
  } as unknown as IProtocolAdapter)
  return new CrossProtocolRouter(registry)
}

describe('O5: unified-route rail reflects the payable value', () => {
  it('classifies a BOLT11 value as lightning even under a spark parameter', () => {
    const [route] = router().resolveUnifiedSend('bitcoin:?spark=lnbc1pvjluezpp5xyz').routes
    expect(route.rail).toBe('lightning')
    expect(route.value).toBe('lnbc1pvjluezpp5xyz')
  })
})
