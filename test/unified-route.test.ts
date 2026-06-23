import { describe, it, expect } from 'vitest'
import { CrossProtocolRouter } from '../src/router'
import { classifyDestination } from '../src/router/destination'
import { buildUnifiedReceiveURI } from '../src/receive/unifiedReceive'
import { ProtocolAdapterRegistry, type IProtocolAdapter } from '../src/adapters/IProtocolAdapter'
import { PROTOCOL_OPERATIONS } from '../src/capabilities/operations'
import type { ProtocolType } from '../src/types/base'

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

const BOLT12 = 'lno1pgexampleofferxyz'
const BOLT11 = 'lnbc1pexampleinvoice'

describe('classifyDestination BOLT12', () => {
  it('recognizes a BOLT12 offer as Lightning', () => {
    const r = classifyDestination(BOLT12)
    expect(r.kind).toBe('BOLT12')
    expect(r.layer).toBe('BTC_LN')
    expect(r.candidates).toContain('RGB_LN')
  })
})

describe('resolveUnifiedSend — multi-rail BIP321', () => {
  const uri = buildUnifiedReceiveURI({
    btcAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
    lightningInvoice: BOLT11,
    lightningOffer: BOLT12,
    liquidAddress: 'lq1qqexampleliquidaddrxyz',
  })

  it('Lightning-first default: BOLT12 offer wins over BOLT11 and on-chain', () => {
    const res = routerWith('RGB_LN', 'LIQUID').resolveUnifiedSend(uri)
    expect(res.source).not.toBeNull()
    expect(res.best?.rail).toBe('lno')
    expect(res.best?.direct).toBe(true)
    // BOLT11 ranks ahead of the on-chain rail.
    const rails = res.routes.filter((r) => r.direct).map((r) => r.rail)
    expect(rails.indexOf('lightning')).toBeLessThan(rails.indexOf('onchain'))
  })

  it('skips rails with no connected taker (LN/onchain unusable → Liquid rail wins)', () => {
    // Only LIQUID connected: it can't take the LN or BTC-L1 rails, but the URI
    // also carries a liquidAddress, so that rail is the only payable one.
    const res = routerWith('LIQUID').resolveUnifiedSend(uri)
    expect(res.best?.rail).toBe('liquid')
    expect(res.routes.every((r) => r.protocol === 'LIQUID')).toBe(true)
  })

  it('honors a per-asset layer preference (Liquid for USDt over Lightning)', () => {
    const usdtUri = buildUnifiedReceiveURI({
      lightningInvoice: BOLT11,
      liquidAddress: 'lq1qqexampleliquidaddrxyz',
      assetId: 'usdt-asset-id',
    })
    const res = routerWith('RGB_LN', 'LIQUID').resolveUnifiedSend(usdtUri, {
      preference: { perAsset: { 'usdt-asset-id': ['BTC_LIQUID', 'BTC_LN'] } },
    })
    expect(res.best?.rail).toBe('liquid')
  })

  it('honors a global layer preference (on-chain first)', () => {
    const res = routerWith('RGB_LN').resolveUnifiedSend(uri, {
      preference: { layers: ['BTC_L1', 'BTC_LN'] },
    })
    expect(res.best?.rail).toBe('onchain')
  })

  it('falls back to single-rail resolveSend for a plain (non-URI) destination', () => {
    const res = routerWith('RGB_LN').resolveUnifiedSend(BOLT11)
    expect(res.source).toBeNull()
    expect(res.best?.rail).toBe('lightning')
    expect(res.best?.value).toBe(BOLT11)
  })

  it('returns no best when nothing payable is connected', () => {
    const res = routerWith('SPARK').resolveUnifiedSend(
      buildUnifiedReceiveURI({ liquidAddress: 'lq1qqexamplexyz' })
    )
    expect(res.best).toBeNull()
  })
})
