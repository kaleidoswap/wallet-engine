import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArkadeAdapter } from '../src/adapters/ArkadeAdapter'
import { ArkadeWdkAdapter } from '../src/adapters/wdk/ArkadeWdkAdapter'
import { arkadeClientManager } from '../src/lib/arkade-client-manager'
import { getCapabilities } from '../src/capabilities'
import { PROTOCOL_OPERATIONS } from '../src/capabilities/operations'
import { CrossProtocolRouter } from '../src/router'
import { ProtocolAdapterRegistry } from '../src/adapters/IProtocolAdapter'

const INVOICE = 'lntbs50u1pexample'
const ARK_ADDR = 'tark1qreceiver'

function wallet() {
  return {
    getAddress: vi.fn(async () => ARK_ADDR),
    sendBitcoin: vi.fn(async () => 'txid'),
  }
}

function nativeAdapter(w = wallet()) {
  vi.spyOn(arkadeClientManager, 'isInitialized').mockReturnValue(true)
  vi.spyOn(arkadeClientManager, 'getWallet').mockReturnValue(w as never)
  return new ArkadeAdapter()
}

function wdkAdapter(w = wallet()) {
  const adapter = new ArkadeWdkAdapter()
  Object.assign(adapter as any, { connected: true, wallet: w })
  return adapter
}

afterEach(() => vi.restoreAllMocks())

describe('Arkade Lightning without Boltz', () => {
  for (const [name, make] of [
    ['ArkadeAdapter', nativeAdapter],
    ['ArkadeWdkAdapter', wdkAdapter],
  ] as const) {
    it(`${name}: sendPayment(bolt11) fails NOT_SUPPORTED and moves no funds`, async () => {
      const w = wallet()
      const adapter = make(w)
      for (const invoice of [INVOICE, `lightning:${INVOICE}`]) {
        await expect(adapter.sendPayment({ invoice, amount: 5000 })).rejects.toMatchObject({
          protocol: 'ARKADE',
          code: 'NOT_SUPPORTED',
        })
      }
      expect(w.sendBitcoin).not.toHaveBeenCalled()
    })

    it(`${name}: createInvoice(BTC_LN) never returns an Ark address`, async () => {
      const w = wallet()
      const adapter = make(w)
      await expect(adapter.createInvoice({ amount: 1000, layer: 'BTC_LN' })).rejects.toMatchObject({
        code: 'NOT_SUPPORTED',
      })
      expect(w.getAddress).not.toHaveBeenCalled()
      // The Ark layer still answers with the receive address.
      expect((await adapter.createInvoice({ amount: 1000 })).invoice).toBe(ARK_ADDR)
    })
  }

  it('capabilities no longer advertise Lightning for ARKADE', () => {
    const caps = getCapabilities('ARKADE')
    expect(caps.supportsLightning).toBe(false)
    expect(caps.layers).not.toContain('BTC_LN')
    expect(PROTOCOL_OPERATIONS.ARKADE).not.toContain('lightning-send')
    expect(PROTOCOL_OPERATIONS.ARKADE).not.toContain('lightning-receive')
  })

  it('a bolt11 is not routed directly to ARKADE', () => {
    const registry = new ProtocolAdapterRegistry()
    registry.register({ protocolName: 'ARKADE', isConnected: () => true } as never)
    const resolution = new CrossProtocolRouter(registry).resolveSend(INVOICE)
    expect(resolution.routes.filter((r) => r.protocol === 'ARKADE' && r.direct)).toHaveLength(0)
    expect(resolution.best).toBeNull()
  })
})
