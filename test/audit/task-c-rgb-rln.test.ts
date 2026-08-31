/**
 * Audit tests — TASK C (RGB assets + RLN node). Branch audit/security-2026-08-30.
 *
 * Each test demonstrates a concrete wrong outcome for a finding in
 * findings/C-rgb-rln.md. No external endpoints: the RLN node is either a plain
 * stub object or a localhost mock HTTP server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { RlnWdkAdapter } from '../../src/adapters/wdk/RlnWdkAdapter'
import { RgbLibWdkAdapter } from '../../src/adapters/wdk/RgbLibWdkAdapter'
import { RgbLibWasmAdapter } from '../../src/adapters/wdk/RgbLibWasmAdapter'
import { decodeBolt11 } from '../../src/lib/bolt11'
import { resolveRgbFeeRatePolicy, MAINNET_FEE_FLOOR } from '../../src/lib/rgb-fee-policy'

// ── Mock the kaleido client manager singleton that RgbAdapter pulls in ──────
const state = { client: null as any, initConfig: null as any }
vi.mock('../../src/lib/kaleido-client-manager', () => ({
  kaleidoClientManager: {
    initialize: (cfg: any) => { state.initConfig = cfg },
    reset: () => {},
    isInitialized: () => true,
    hasNode: () => true,
    getClient: () => state.client,
  },
}))
import { RgbAdapter } from '../../src/adapters/RgbAdapter'

afterEach(() => {
  state.client = null
})

function connectedRgbAdapter(config?: Record<string, unknown>) {
  const adapter = new RgbAdapter()
  Object.assign(adapter as any, {
    connected: true,
    config: { protocol: 'RGB_LN', makerUrl: '', nodeUrl: 'http://mock', ...config },
  })
  return adapter
}

// ── F1: asset-id shadowing via issuer-controlled ticker ─────────────────────
describe('F1: RgbAdapter.getAsset ticker shadowing', () => {
  const real = {
    asset_id: 'rgb:real-usdt',
    name: 'Tether USD',
    ticker: 'USDT',
    precision: 6,
    balance: { settled: 100, future: 100, spendable: 100 },
  }
  // A malicious issuer sets their asset's ticker to the REAL asset's id string.
  const scam = {
    asset_id: 'rgb:scam-asset',
    name: 'Tether USD',
    ticker: 'rgb:real-usdt',
    precision: 6,
    balance: { settled: 999_000, future: 999_000, spendable: 999_000 },
  }

  it('[FIXED] an asset whose ticker equals a real asset id must not shadow the exact-id lookup', async () => {
    state.client = { rln: { listAssets: async () => ({ nia: [scam, real] }) } }
    const adapter = connectedRgbAdapter()
    const found = await adapter.getAsset('rgb:real-usdt')
    // The contract id is the identity: the exact-id match wins over any
    // issuer-chosen ticker, whatever order the node lists them in.
    expect(found.id).toBe('rgb:real-usdt')
    expect(found.balance.total).not.toBe(999_000)
  })

  it('[FIXED] duplicate tickers are ambiguous, not silently resolved to the first-listed asset', async () => {
    const scamUsdt = { ...scam, ticker: 'USDT' }
    state.client = { rln: { listAssets: async () => ({ nia: [scamUsdt, real] }) } }
    const adapter = connectedRgbAdapter()
    await expect(adapter.getAsset('USDT')).rejects.toThrow(/Ambiguous asset ticker/)
  })

  it('[FIXED] an unambiguous ticker still resolves, for hosts that look up by symbol', async () => {
    state.client = { rln: { listAssets: async () => ({ nia: [real] }) } }
    const adapter = connectedRgbAdapter()
    const found = await adapter.getAsset('USDT')
    expect(found.id).toBe('rgb:real-usdt')
  })
})

// ── F2: contradictory BTC balances within one adapter ───────────────────────
describe('F2: RgbAdapter BTC balance contradiction (colored sats counted as BTC)', () => {
  it("getBtcBalance and getAssetBalance('BTC') disagree on the same node state", async () => {
    const btcBalance = {
      vanilla: { settled: 5000, future: 5000, spendable: 5000 },
      colored: { settled: 2000, future: 2000, spendable: 2000 },
    }
    state.client = { rln: { getBtcBalance: async () => btcBalance } }
    const adapter = connectedRgbAdapter()

    const assetView = await adapter.getAssetBalance('BTC') // convertBtcBalance: vanilla only
    const btcView = await adapter.getBtcBalance() // vanilla + colored

    // FIXED (audit finding C-F2): getBtcBalance() is vanilla-only, matching the
    // policy convertBtcBalance documents. One adapter, one answer.
    expect(assetView.total).toBe(5000)
    expect(btcView.confirmed).toBe(5000)
    expect(btcView.total).toBe(5000)
  })
})

// ── F3: decodeInvoice drops the RGB invoice amount ──────────────────────────
function connectedRln(account: any, extra: Record<string, unknown> = {}) {
  const adapter = new RlnWdkAdapter()
  Object.assign(adapter as any, { connected: true, account, ...extra })
  return adapter
}

describe('F3: RlnWdkAdapter.decodeInvoice drops RGB on-chain invoice amounts', () => {
  it('returns no amount at all for an amount-bearing RGB invoice (assignment is never read)', async () => {
    const adapter = connectedRln({
      // Real DecodeRGBInvoiceResponse shape (kaleido-sdk generated types):
      decodeRgbInvoice: async () => ({
        recipient_id: 'bcrt:utxob:cbgHUJ4e-7QyKY4U',
        recipient_type: 'Blind',
        asset_id: 'rgb:usdt',
        assignment: { Fungible: 100 }, // <-- the requested amount lives HERE
        network: 'Regtest',
        expiration_timestamp: 2_000_000_000,
        transport_endpoints: ['rpcs://proxy.example/0.2/json-rpc'],
        unknown_query_params: {},
      }),
    })
    const d = await adapter.decodeInvoice('rgb:icfqnK9y-wObZKTu?expiry=2000000000')
    expect(d.asset_id).toBe('rgb:usdt')
    expect(d.asset_amount).toBeUndefined() // DROPPED: user pays blind
    expect(d.amount).toBeUndefined()
  })
})

// ── F4: no network validation before paying ─────────────────────────────────
describe('F4: no client-side invoice validation before paying', () => {
  it('a testnet-configured adapter forwards a mainnet (lnbc…) invoice to the node unchallenged', async () => {
    const sent: any[] = []
    const adapter = connectedRln(
      { _rln: { sendPayment: async (b: any) => { sent.push(b); return { payment_hash: 'ph', status: 'Succeeded' } } } },
      { network: 'testnet' },
    )
    const invoice = 'lnbc210u1pexamplemainnet' // mainnet HRP, amount-bearing
    expect(decodeBolt11(invoice).network).toBe('bc') // parseable — and never checked
    const r = await adapter.sendPayment({ invoice })
    expect(sent[0].invoice).toBe(invoice) // forwarded as-is
    expect(r.status).toBe('confirmed')
  })

  it('expiry is not part of the parse at all — nothing in the engine can reject an expired invoice', () => {
    const summary = decodeBolt11('lnbc210u1pexample')
    expect(Object.keys(summary)).not.toContain('expiresAt')
    expect(Object.keys(summary)).not.toContain('paymentHash')
  })
})

// ── F5: fee-policy gaps ─────────────────────────────────────────────────────
describe('F5: fee policy gaps', () => {
  it('[FIXED] a config that omits `network` fails CLOSED to the mainnet path, estimator consulted', async () => {
    let estimatorCalled = false
    state.client = {
      rln: {
        sendBtc: vi.fn(async (b: any) => b),
        estimateFee: async () => { estimatorCalled = true; return { fee_rate: 50 } },
      },
    }
    const adapter = connectedRgbAdapter() // no `network` key — optional in BaseProtocolConfig
    await adapter.sendBtcOnchain({ address: 'bc1qexample', amount: 10_000 })
    const body = (state.client.rln.sendBtc as any).mock.calls[0][0]
    // An absent network must not resolve to the 1 sat/vB non-mainnet default on
    // what may be a mainnet wallet: the estimator runs and the floor applies.
    expect(estimatorCalled).toBe(true)
    expect(body.fee_rate).toBe(50)
    expect(body.fee_rate).toBeGreaterThanOrEqual(MAINNET_FEE_FLOOR.normal)
  })

  it('a caller-provided feeRate is forwarded uncapped (100,000 sat/vB on a 10,000 sat send)', async () => {
    state.client = { rln: { sendBtc: vi.fn(async (b: any) => b) } }
    const adapter = connectedRgbAdapter({ network: 'mainnet' })
    await adapter.sendBtcOnchain({ address: 'bc1qexample', amount: 10_000, feeRate: 100_000 })
    const body = (state.client.rln.sendBtc as any).mock.calls[0][0]
    expect(body.fee_rate).toBe(100_000)
  })

  it('pure policy: provided rate wins with no ceiling; null network short-circuits the estimator', async () => {
    const est = async () => 50
    expect(await resolveRgbFeeRatePolicy({ provided: 1_000_000, urgency: 'normal', network: 'mainnet', estimateFn: est }))
      .toBe(1_000_000)
    expect(await resolveRgbFeeRatePolicy({ provided: undefined, urgency: 'normal', network: null, estimateFn: est }))
      .toBe(1)
  })

  it('[FIXED] RlnWdkAdapter.sendAsset without feeRate floors instead of forwarding undefined', async () => {
    const calls: any[] = []
    const adapter = connectedRln({
      sendRgb: async (p: any) => { calls.push(p); return { txid: 'x' } },
      estimateFee: async () => ({ fee_rate: 42 }),
    })
    await adapter.sendAsset({ assetId: 'rgb:x', recipientId: 'r', amount: 5, transportEndpoints: [] })
    // Forwarding `undefined` let WDK's own 3 sat/vB default build a mainnet RGB
    // spend below the floor the engine defines for exactly this case.
    expect(calls[0].feeRate).toBe(MAINNET_FEE_FLOOR.normal)
  })
})

// ── F6: auth fail-open (localhost mock node, real WDK module) ───────────────
describe('F6: RLN apiKey forwarding / fail-open', () => {
  const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  let server: http.Server | null = null
  let captured: Array<{ url?: string; auth?: string }> = []

  async function startMockNode() {
    captured = []
    server = http.createServer((req, res) => {
      captured.push({ url: req.url, auth: req.headers.authorization as string | undefined })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ pubkey: '02' + 'ab'.repeat(32) }))
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  }

  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r))
    server = null
  })

  it('with apiKey: every node request carries Authorization: Bearer, and the key never appears in a URL', async () => {
    const nodeUrl = await startMockNode()
    const adapter = new RlnWdkAdapter()
    await adapter.connect({ protocol: 'RGB_LN', mnemonic: MNEMONIC, nodeUrl, network: 'regtest', apiKey: 'secret-token' } as any)
    await adapter.getConnectionInfo() // getNodeInfo
    expect(captured.length).toBeGreaterThan(0)
    for (const r of captured) {
      expect(r.auth).toBe('Bearer secret-token')
      expect(r.url ?? '').not.toContain('secret-token')
    }
    await adapter.disconnect()
  })

  it('without apiKey: connect and calls succeed with NO auth header and NO error (fail-open)', async () => {
    const nodeUrl = await startMockNode()
    const adapter = new RlnWdkAdapter()
    await adapter.connect({ protocol: 'RGB_LN', mnemonic: MNEMONIC, nodeUrl, network: 'regtest' } as any)
    await adapter.getConnectionInfo()
    expect(captured.length).toBeGreaterThan(0)
    for (const r of captured) expect(r.auth).toBeUndefined()
    await adapter.disconnect()
  })
})

// ── F6b: RgbConfig.jwt is documented but silently dropped ───────────────────
describe('F6b: RgbAdapter drops RgbConfig.jwt', () => {
  it('a host that sets `jwt` per the RgbConfig docs connects with NO credential forwarded', async () => {
    state.client = { rln: { getNodeInfo: async () => ({ pubkey: '02ab' }) } }
    const adapter = new RgbAdapter()
    await adapter.connect({
      protocol: 'RGB_LN',
      makerUrl: '',
      nodeUrl: 'http://mock-node',
      jwt: 'node-bearer-token', // documented in src/types/rgb.ts:28 as the node credential
    } as any)
    // FIXED (audit finding C-F8): `jwt` is now forwarded as the node credential,
    // with the same `jwt ?? apiKey` precedence as RlnWdkAdapter.ts:154.
    expect(state.initConfig.apiKey).toBe('node-bearer-token')
    await adapter.disconnect()
  })
})

// ── F8: PaymentResult.amount echoes the caller, not the payment ─────────────
describe('F8: RlnWdkAdapter.sendPayment misreports the paid amount', () => {
  it('paying a 21,000-sat amount-bearing invoice returns PaymentResult.amount = 0', async () => {
    const adapter = connectedRln({
      _rln: { sendPayment: async () => ({ payment_hash: 'ph', payment_secret: 'sec', status: 'Succeeded' }) },
    })
    // lnbc210u1… = 210 µBTC = 21,000 sats; caller passes no `amount` (correctly —
    // the invoice carries it), and the node's SendPaymentResponse has no amount field.
    const r = await adapter.sendPayment({ invoice: 'lnbc210u1pexample' })
    expect(r.status).toBe('confirmed')
    expect(r.amount).toBe(0) // recorded/displayed as a 0-sat payment
  })
})

// ── F7: RGB-L1 adapters silently return zero balances ───────────────────────
describe('F7: zero balance instead of an error', () => {
  it('RgbLibWdkAdapter: unknown asset id → silent zero from getAssetBalance while getAsset throws', async () => {
    const adapter = new RgbLibWdkAdapter()
    Object.assign(adapter as any, {
      connected: true,
      account: {
        registerWallet: async () => ({ address: 'a', btcBalance: { vanilla: { settled: 0, future: 0, spendable: 0 } } }),
        listAssets: async () => [],
      },
    })
    const bal = await adapter.getAssetBalance('rgb:does-not-exist')
    expect(bal.total).toBe(0) // silent zero…
    await expect(adapter.getAsset('rgb:does-not-exist')).rejects.toThrow(/Unknown asset/) // …but getAsset errors
  })

  it('RgbLibWasmAdapter: a throwing getAssetBalance backend is reported as a zero balance', async () => {
    const adapter = new RgbLibWasmAdapter()
    Object.assign(adapter as any, {
      connected: true,
      account: {
        getBtcBalance: async () => ({ vanilla: { settled: 0, spendable: 0, future: 0 }, colored: { settled: 0, spendable: 0, future: 0 } }),
        listAssets: async () => ({ nia: [], ifa: [] }),
        getAssetBalance: async () => { throw new Error('indexer unreachable') },
      },
    })
    const bal = await adapter.getAssetBalance('rgb:real-asset-held-by-user')
    expect(bal.total).toBe(0) // "your funds are gone" — actually the indexer is down
  })
})
