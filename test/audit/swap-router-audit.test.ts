/**
 * Audit tests — TASK B (swap atomicity, router, #55 remediation verification).
 *
 * These tests assert the CURRENT behavior of the code at 32c351c. Where that
 * behavior is the vulnerability, the assertion documents the bug (and what a
 * fixed version must do instead) — they pass against the audited code so the
 * suite stays green; each maps to finding F<n> in findings/B-swap-router.md.
 *
 * Everything is mocked: no network, no live endpoint, no real SDK client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KaleidoswapSwap } from '../../src/swap/KaleidoswapSwap'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'
import { CrossProtocolRouter } from '../../src/router'
import { ProtocolAdapterRegistry, type IProtocolAdapter } from '../../src/adapters/IProtocolAdapter'
import { PROTOCOL_OPERATIONS } from '../../src/capabilities/operations'
import type { ProtocolType } from '../../src/types/base'
import * as orchestra from '../../src/lib/orchestra-client'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const REQ = {
  fromAsset: 'rgb:USDT',
  toAsset: 'BTC',
  fromLayer: 'RGB_LN',
  toLayer: 'BTC_LN',
  fromAmount: 100_000, // raw base units — user asks to sell a FIXED input
}

const APPROVED = {
  id: 'rfq-1',
  fromAsset: REQ.fromAsset,
  fromAmount: 100_000,
  toAsset: REQ.toAsset,
  toAmount: 5_000,
  price: 20,
  fee: { amount: 10, asset: REQ.fromAsset },
  expiresAt: Date.now() + 60_000,
  provider: 'kaleidoswap' as const,
}

function swapWithProto(proto: any) {
  const swap = new KaleidoswapSwap({} as any, { baseUrl: 'http://localhost' })
  ;(swap as any).proto = proto
  return swap
}

/** Wire an RgbAdapter to a fully fake kaleido client (no network anywhere). */
function rgbAdapterWithClient(client: any) {
  ;(kaleidoClientManager as any).client = client
  ;(kaleidoClientManager as any).config = { baseUrl: 'http://maker.local' }
  const adapter = new RgbAdapter()
  ;(adapter as any).connected = true
  ;(adapter as any).config = { makerUrl: 'http://maker.local' }
  return adapter
}

function stubAdapter(protocol: ProtocolType): IProtocolAdapter {
  return {
    protocolName: protocol,
    supportedLayers: [],
    version: 'test',
    capabilities: PROTOCOL_OPERATIONS[protocol],
    isConnected: () => true,
  } as unknown as IProtocolAdapter
}

function routerWith(...protocols: ProtocolType[]) {
  const r = new ProtocolAdapterRegistry()
  for (const p of protocols) r.register(stubAdapter(p))
  return new CrossProtocolRouter(r)
}

afterEach(() => {
  kaleidoClientManager.reset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// F1 — maker-controlled quote legs flow unchecked into execution
// ---------------------------------------------------------------------------

describe('F1: maker-inflated / substituted quote legs are not re-validated', () => {
  it('F1a (WDK path): maker returning 100x the requested fixed leg sails through getQuote and into swap()', async () => {
    let executed: any = null
    const swap = swapWithProto({
      quoteSwap: async () => ({
        rfqId: 'rfq-evil',
        tokenInAmount: 10_000_000, // user asked to sell exactly 100_000
        tokenOutAmount: 5_000,
        price: 20,
        fee: 10,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }),
      swap: async (opts: any) => (
        (executed = opts),
        { paymentHash: 'ph', status: 'Waiting', tokenInAmount: opts.tokenInAmount, tokenOutAmount: opts.tokenOutAmount }
      ),
    })

    const quote = await swap.getQuote(REQ as any)
    // VULNERABILITY: no check that the echoed fixed leg equals the request.
    expect(quote.fromAmount).toBe(10_000_000)

    await swap.executeSwap(quote as any)
    // ... and the inflated amount is what gets ordered at the maker.
    expect(executed.tokenInAmount).toBe(10_000_000)
    expect(executed.rfqId).toBe('rfq-evil')
  })

  it('F1b (native path): maker-substituted asset id + inflated amount enter the Quote and are sent to initSwap', async () => {
    let initBody: any = null
    const adapter = rgbAdapterWithClient({
      maker: {
        getQuote: async () => ({
          rfq_id: 'rfq-evil',
          from_asset: { asset_id: 'rgb:WORTHLESS', amount: 9_000_000 }, // requested rgb:USDT / 100_000
          to_asset: { asset_id: 'BTC', amount: 5_000 },
          price: 20,
          fee: { final_fee: 10, fee_asset: 'BTC', base_fee: 10, variable_fee: 0 },
          expires_at: Math.floor(Date.now() / 1000) + 60,
        }),
        initSwap: async (body: any) => (
          (initBody = body),
          { swapstring: 'ss', payment_hash: 'ph', access_token: 'tok' }
        ),
        executeSwap: async () => ({ status: 200 }),
      },
      rln: {
        whitelistSwap: async () => {},
        getTakerPubkey: async () => 'pub',
      },
    })

    const quote = await adapter.getSwapQuote(REQ as any)
    // VULNERABILITY: asset id and amount come from the RESPONSE, not the request.
    expect(quote.fromAsset).toBe('rgb:WORTHLESS')
    expect(quote.fromAmount).toBe(9_000_000)

    await adapter.executeSwap(quote)
    expect(initBody.from_asset).toBe('rgb:WORTHLESS')
    expect(initBody.from_amount).toBe(9_000_000)
  })
})

// ---------------------------------------------------------------------------
// F2 — native quote path fails open on malformed maker fields
// ---------------------------------------------------------------------------

describe('F2: native RgbAdapter quote coercion fails open (C1/L1 partial)', () => {
  function adapterWithQuoteResponse(quoteResponse: any, capture: { init?: any }) {
    return rgbAdapterWithClient({
      maker: {
        getQuote: async () => quoteResponse,
        initSwap: async (body: any) => (
          (capture.init = body),
          { swapstring: 'ss', payment_hash: 'ph', access_token: 'tok' }
        ),
        executeSwap: async () => ({ status: 200 }),
      },
      rln: { whitelistSwap: async () => {}, getTakerPubkey: async () => 'pub' },
    })
  }

  it('F2a: missing expires_at -> NaN expiresAt -> expiry guard disabled, stale quote executes', async () => {
    const capture: { init?: any } = {}
    const adapter = adapterWithQuoteResponse(
      {
        rfq_id: 'rfq-stale',
        from_asset: { asset_id: 'rgb:USDT', amount: 100_000 },
        to_asset: { asset_id: 'BTC', amount: 5_000 },
        price: 20,
        fee: { final_fee: 10, fee_asset: 'BTC', base_fee: 10, variable_fee: 0 },
        expires_at: undefined, // renamed/missing field on the wire
      },
      capture,
    )

    const quote = await adapter.getSwapQuote(REQ as any)
    expect(quote.expiresAt).toBeNaN() // undefined * 1000 — still true of getSwapQuote

    // FIXED (audit finding B-F2): a non-finite expiry now fails closed instead of
    // disabling the guard. The remaining NaN above is why F4 below still stands:
    // getSwapQuote does not validate the maker's numeric fields.
    await expect(adapter.executeSwap(quote)).rejects.toThrow(/expir/i)
    expect(capture.init, 'must not reach the maker').toBeFalsy()
  })

  it('F2b: negative fee / price from a hostile maker flow into the Quote unfiltered', async () => {
    const adapter = adapterWithQuoteResponse(
      {
        rfq_id: 'rfq-neg',
        from_asset: { asset_id: 'rgb:USDT', amount: 100_000 },
        to_asset: { asset_id: 'BTC', amount: 5_000 },
        price: -20,
        fee: { final_fee: -500, fee_asset: 'BTC', base_fee: -500, variable_fee: 0 },
        expires_at: Math.floor(Date.now() / 1000) + 60,
      },
      {},
    )
    const quote = await adapter.getSwapQuote(REQ as any)
    // The WDK path throws on exactly this (toAmount, KaleidoswapSwap.ts:36-38).
    expect(quote.fee.amount).toBe(-500)
    expect(quote.price).toBe(-20)
  })
})

// ---------------------------------------------------------------------------
// F3 — no replay / double-execution guard
// ---------------------------------------------------------------------------

describe('F3: executeSwap has no in-flight / idempotency guard', () => {
  it('two concurrent executeSwap calls with the same quote both reach the maker', async () => {
    let calls = 0
    const swap = swapWithProto({
      swap: async () => (calls++, { paymentHash: `ph${calls}`, status: 'Waiting', tokenInAmount: 1, tokenOutAmount: 1 }),
    })
    await Promise.all([swap.executeSwap(APPROVED as any), swap.executeSwap(APPROVED as any)])
    // VULNERABILITY: same rfq id executed twice. Maker OpenAPI: "Treat this as
    // non-idempotent: creating a second swap requires a new request."
    expect(calls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// F4 — failure between initSwap and executeSwap strands the swap untracked
// ---------------------------------------------------------------------------

describe('F4: partial failure after initSwap discards payment_hash + access_token', () => {
  it('maker.executeSwap rejects after init+whitelist -> nothing about the live swap is retained', async () => {
    const adapter = rgbAdapterWithClient({
      maker: {
        initSwap: async () => ({ swapstring: 'ss', payment_hash: 'ph-live', access_token: 'tok-live' }),
        // Server accepted execution but the response was lost (timeout).
        executeSwap: async () => {
          throw new Error('socket timeout after server accepted execution')
        },
      },
      rln: { whitelistSwap: async () => {}, getTakerPubkey: async () => 'pub' },
    })

    await expect(adapter.executeSwap(APPROVED as any)).rejects.toThrow()

    // VULNERABILITY: the swap is live at the maker, but the wallet kept neither
    // the payment hash nor the access token REQUIRED to poll its status.
    expect((adapter as any).swapAccessTokens.size).toBe(0)
    // getSwapStatus now goes out with an empty access_token for a swap the
    // caller never even learned the hash of.
  })
})

// ---------------------------------------------------------------------------
// F5/F6/F7 — router
// ---------------------------------------------------------------------------

describe('F5: router certifies BOLT12 routes no adapter can fulfil', () => {
  it('lno1 offer -> best.direct === true for adapters that only pay BOLT11', () => {
    const router = routerWith('RGB_LN', 'SPARK', 'ARKADE')
    const res = router.resolveSend('lno1pgexampleofferxyz')
    // VULNERABILITY: the router's contract is "best is always a genuinely-direct
    // route" (router/index.ts:122-124) — yet SparkAdapter.ts:679 feeds any "ln*"
    // string to BOLT11-only payLightningInvoice, ArkadeAdapter.ts:77-84 matches
    // bolt11 prefixes only, and RgbAdapter.ts:496-524 has no offer flow at all.
    expect(res.best).not.toBeNull()
    expect(res.best!.direct).toBe(true)
    expect(['RGB_LN', 'SPARK', 'ARKADE']).toContain(res.best!.protocol)
  })
})

describe('F6: crafted BIP321 URI drives lite-mode auto-pay onto the attacker rail', () => {
  it('merchant-looking onchain address + attacker lno offer -> best is the attacker offer', () => {
    const attackerOffer = 'lno1zcpq8gq7vpnq9e7v9s8ykz3attackercontrolledoffer'
    const uri = `bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080?amount=0.001&lno=${attackerOffer}`
    const router = routerWith('RGB_LN')
    const res = router.resolveUnifiedSend(uri)
    // VULNERABILITY: rails are NOT cryptographically bound (the engine's own
    // warning, unifiedReceive.ts:146-151), yet `.best` auto-selects the
    // Lightning-first rail with no amount/payee consistency check.
    expect(res.best).not.toBeNull()
    expect(res.best!.rail).toBe('lno')
    expect(res.best!.value).toBe(attackerOffer)
  })
})

describe('F7: resolveSend drops the BIP21 lightning= fallback', () => {
  it('bitcoin:addr?lightning=lnbc1... resolves to on-chain only', () => {
    const router = routerWith('RGB_LN') // RGB_LN supports BOTH onchain and lightning
    const res = router.resolveSend(
      'bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080?lightning=lnbc1pexampleinvoice',
    )
    // The classifier surfaced the fallback...
    expect(res.destination.lightningFallback).toBe('lnbc1pexampleinvoice')
    // ...but the router never uses it: only the on-chain route exists.
    expect(res.routes.every((r) => r.layer === 'BTC_L1')).toBe(true)
    expect(res.best!.direct).toBe(true) // lite mode pays on-chain fees instead of LN
  })
})

// ---------------------------------------------------------------------------
// F8/F9 — orchestra client
// ---------------------------------------------------------------------------

describe('F8: orchestra idempotency keys are random per request', () => {
  it('two identical submitOrder calls send different X-Idempotency-Key headers', async () => {
    orchestra.setOrchestraApiKey('test-key')
    const keys: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: any, init: any) => {
        keys.push((init.headers as Record<string, string>)['X-Idempotency-Key'])
        return { ok: true, json: async () => ({ orderId: 'o1', status: 'processing' }) } as any
      }),
    )
    await orchestra.submitOrder({ quoteId: 'q1', txHash: 'tx' })
    await orchestra.submitOrder({ quoteId: 'q1', txHash: 'tx' }) // the retry
    // VULNERABILITY: a retry is indistinguishable from a new operation.
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
  })
})

describe('F9: orchestra getStatus leaks the wrapper when order is null', () => {
  it('{quote, order: null} response -> returned "order" has undefined status and wrapper keys', async () => {
    orchestra.setOrchestraApiKey('test-key')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ quote: { quoteId: 'q1' }, order: null, stages: [] }),
      })) as any,
    )
    const order = await orchestra.getStatus({ quoteId: 'q1' })
    // VULNERABILITY: the exact "status is undefined" failure the unwrap claims to fix.
    expect(order.status).toBeUndefined()
    expect((order as any).order).toBeNull() // the wrapper leaked through as the order
  })
})
