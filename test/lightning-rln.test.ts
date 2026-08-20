import { afterEach, describe, expect, it, vi } from 'vitest'
import { KaleidoClient } from 'kaleido-sdk'

import { RlnLightningPayments } from '../src/lightning/rln/RlnLightningPayments'
import { bolt11Fixture, TEST_PAYMENT_HASH, TEST_PREIMAGE } from './fixtures/bolt11'

function directClient(overrides: Record<string, unknown> = {}) {
  const rln = {
    getNetworkInfo: vi.fn(async () => ({ network: 'Regtest', height: 432 })),
    getNodeInfo: vi.fn(async () => ({ pubkey: '03'.padEnd(66, '2') })),
    createLNInvoice: vi.fn(),
    getInvoiceStatus: vi.fn(),
    sendPayment: vi.fn(),
    getPayment: vi.fn(),
    ...overrides,
  }
  return { rln, close: vi.fn(async () => undefined) }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('RlnLightningPayments', () => {
  it('uses the shared node-only HTTP seam and never constructs the maker-capable SDK client', async () => {
    const create = vi.spyOn(KaleidoClient, 'create')
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      const body = request.url.endsWith('/networkinfo')
        ? { network: 'Regtest', height: 432 }
        : { pubkey: '03'.padEnd(66, '2') }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetch)
    const payments = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      nodeApiKey: 'node-custody-secret',
    })

    await payments.getNetwork()
    expect(create).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [input] of fetch.mock.calls) {
      const request = input instanceof Request ? input : new Request(input)
      expect(request.url).toMatch(/^https:\/\/node\.example\/(?:networkinfo|nodeinfo)$/)
      expect(request.headers.get('authorization')).toBe('Bearer node-custody-secret')
    }
    await payments.close()
  })

  it('normalizes provider network identity and advertises the restricted vanilla-BTC surface', async () => {
    const client = directClient()
    const payments = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      expectedNetworkId: 'regtest',
      clientFactory: () => client,
    })

    await expect(payments.getNetwork()).resolves.toEqual({
      chain: 'bitcoin',
      networkId: 'regtest',
      nodePubkey: '03'.padEnd(66, '2'),
      blockHeight: 432,
      evidence: 'provider-reported',
    })
    await expect(payments.getCapabilities()).resolves.toEqual({
      createInvoice: true,
      payInvoice: true,
      lookupInvoice: false,
      lookupPayment: true,
      amountlessInvoices: true,
      maxFeeControl: false,
      idempotencyKeys: false,
      keysend: false,
    })
  })

  it('creates and tracks a vanilla-BTC invoice with exact amount and normalized status', async () => {
    const invoice = bolt11Fixture({ hrp: 'lnbcrt10n' })
    const client = directClient({
      createLNInvoice: vi.fn(async () => ({ invoice })),
      getInvoiceStatus: vi.fn(async () => ({ status: 'Succeeded' })),
    })
    const payments = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      clientFactory: () => client,
      expectedNetworkId: 'regtest',
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.createInvoice({
      amountMsat: '1000',
      expirySeconds: 3600,
      requestId: 'invoice-1',
    })).resolves.toEqual({
      bolt11: invoice,
      paymentHash: TEST_PAYMENT_HASH,
      amountMsat: '1000',
      status: 'unpaid',
      createdAtUnixSeconds: 1_700_000_000,
      expiresAtUnixSeconds: 1_700_003_600,
    })
    expect(client.rln.createLNInvoice).toHaveBeenCalledWith({ amt_msat: 1_000, expiry_sec: 3_600 })

    await expect(payments.lookupInvoice({ paymentHash: TEST_PAYMENT_HASH })).resolves.toMatchObject({
      paymentHash: TEST_PAYMENT_HASH,
      status: 'paid',
    })
    expect(client.rln.getInvoiceStatus).toHaveBeenCalledWith({ invoice })
  })

  it('supports amountless invoices but rejects unsafe amounts and unsupported descriptions before RPC', async () => {
    const amountless = bolt11Fixture({ hrp: 'lnbcrt' })
    const client = directClient({ createLNInvoice: vi.fn(async () => ({ invoice: amountless })) })
    const payments = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      clientFactory: () => client,
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.createInvoice({ requestId: 'invoice-open' })).resolves.toMatchObject({
      paymentHash: TEST_PAYMENT_HASH,
    })
    expect(client.rln.createLNInvoice).toHaveBeenLastCalledWith({ expiry_sec: 3_600 })

    await expect(payments.createInvoice({
      amountMsat: '9007199254740992',
      requestId: 'invoice-unsafe',
    })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    await expect(payments.createInvoice({
      amountMsat: '1000',
      description: 'RLN has no vanilla invoice description field',
      requestId: 'invoice-description',
    })).rejects.toMatchObject({ code: 'METHOD_UNSUPPORTED' })
    expect(client.rln.createLNInvoice).toHaveBeenCalledTimes(1)
  })

  it('validates network and an exact amountless-invoice amount before direct RLN payment', async () => {
    const invoice = bolt11Fixture({ hrp: 'lnbcrt' })
    const client = directClient({
      sendPayment: vi.fn(async () => ({
        payment_id: TEST_PAYMENT_HASH,
        payment_hash: TEST_PAYMENT_HASH,
        payment_secret: 'must-not-escape',
        status: 'Succeeded',
      })),
    })
    const payments = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      clientFactory: () => client,
      expectedNetworkId: 'regtest',
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.payInvoice({
      bolt11: invoice,
      amountMsat: '2000',
      requestId: 'payment-1',
    })).resolves.toEqual({
      paymentHash: TEST_PAYMENT_HASH,
      amountMsat: '2000',
      status: 'succeeded',
      settledAtUnixSeconds: 1_700_000_100,
    })
    expect(client.rln.sendPayment).toHaveBeenCalledWith({ invoice, amt_msat: 2_000 })
  })

  it('requires a matching response payment hash before reporting direct RLN success', async () => {
    const client = directClient({
      sendPayment: vi.fn(async () => ({
        payment_id: 'provider-local-id',
        status: 'Succeeded',
      })),
    })
    const payments = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      clientFactory: () => client,
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.payInvoice({
      bolt11: bolt11Fixture({ hrp: 'lnbcrt10n' }),
      requestId: 'payment-missing-hash',
    })).rejects.toMatchObject({
      code: 'PAYMENT_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })
  })

  it('requires a valid provider status before returning a direct RLN payment result', async () => {
    const client = directClient({
      sendPayment: vi.fn(async () => ({
        payment_id: 'provider-local-id',
        payment_hash: TEST_PAYMENT_HASH,
      })),
    })
    const payments = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      clientFactory: () => client,
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.payInvoice({
      bolt11: bolt11Fixture({ hrp: 'lnbcrt10n' }),
      requestId: 'payment-missing-status',
    })).rejects.toMatchObject({
      code: 'PAYMENT_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })
  })

  it('classifies a malformed fulfilled direct RLN response as non-retryable ambiguity', async () => {
    const client = directClient({
      sendPayment: vi.fn(async () => null),
    })
    const payments = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      clientFactory: () => client,
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.payInvoice({
      bolt11: bolt11Fixture({ hrp: 'lnbcrt10n' }),
      requestId: 'payment-malformed-response',
    })).rejects.toMatchObject({
      code: 'PAYMENT_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })
  })

  it('rejects fee, invoice-network, and fixed-amount mismatches before direct RLN payment', async () => {
    const feeClient = directClient()
    const fee = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      clientFactory: () => feeClient,
    })
    await expect(fee.payInvoice({
      bolt11: bolt11Fixture({ hrp: 'lnbcrt10n' }),
      maxFeeMsat: '1',
      requestId: 'payment-fee',
    })).rejects.toMatchObject({ code: 'MAX_FEE_UNSUPPORTED' })
    expect(feeClient.rln.getNetworkInfo).not.toHaveBeenCalled()
    expect(feeClient.rln.sendPayment).not.toHaveBeenCalled()

    const guardedClient = directClient()
    const guarded = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      clientFactory: () => guardedClient,
      nowUnixSeconds: () => 1_700_000_100,
    })
    await expect(guarded.payInvoice({
      bolt11: bolt11Fixture({ hrp: 'lnbc10n' }),
      requestId: 'payment-network',
    })).rejects.toMatchObject({ code: 'NETWORK_MISMATCH' })
    await expect(guarded.payInvoice({
      bolt11: bolt11Fixture({ hrp: 'lnbcrt10n' }),
      amountMsat: '2000',
      requestId: 'payment-amount',
    })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    expect(guardedClient.rln.sendPayment).not.toHaveBeenCalled()
  })

  it('maps direct RLN send failures to secret-free ambiguous diagnostics', async () => {
    const invoice = bolt11Fixture({ hrp: 'lnbcrt10n' })
    const preimage = 'aa'.repeat(32)
    const client = directClient({
      sendPayment: vi.fn(async () => {
        throw new Error(`${invoice} ${preimage} node-custody-secret`)
      }),
    })
    const payments = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      nodeApiKey: 'node-custody-secret',
      clientFactory: () => client,
      nowUnixSeconds: () => 1_700_000_100,
    })

    const error = await payments.payInvoice({
      bolt11: invoice,
      requestId: 'payment-error',
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'PAYMENT_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
      cause: undefined,
    })
    expect(String(error)).not.toContain(invoice)
    expect(String(error)).not.toContain(preimage)
    expect(String(error)).not.toContain('node-custody-secret')
    expect(JSON.stringify(payments)).not.toContain('node-custody-secret')
  })

  it('normalizes an outbound direct RLN payment lookup and never exposes provider payment secrets', async () => {
    const preimage = TEST_PREIMAGE
    const client = directClient({
      getPayment: vi.fn(async () => ({
        payment: {
          payment_hash: TEST_PAYMENT_HASH,
          inbound: false,
          amt_msat: 2_000,
          status: 'Succeeded',
          created_at: 1_700_000_000,
          updated_at: 1_700_000_200,
          preimage,
          payment_secret: 'provider-internal-secret',
        },
      })),
    })
    const payments = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      clientFactory: () => client,
      expectedNetworkId: 'regtest',
    })

    await expect(payments.lookupPayment({ paymentHash: TEST_PAYMENT_HASH })).resolves.toEqual({
      paymentHash: TEST_PAYMENT_HASH,
      amountMsat: '2000',
      preimage,
      status: 'succeeded',
      createdAtUnixSeconds: 1_700_000_000,
      settledAtUnixSeconds: 1_700_000_200,
    })
    expect(client.rln.getPayment).toHaveBeenCalledWith({ payment_hash: TEST_PAYMENT_HASH })
  })

  it('rejects inbound or precision-lost provider records as outgoing payment lookups', async () => {
    const inboundClient = directClient({
      getPayment: vi.fn(async () => ({
        payment: { payment_hash: TEST_PAYMENT_HASH, inbound: true, status: 'Succeeded' },
      })),
    })
    const inbound = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      clientFactory: () => inboundClient,
    })
    await expect(inbound.lookupPayment({ paymentHash: TEST_PAYMENT_HASH }))
      .rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' })

    const unsafeClient = directClient({
      getPayment: vi.fn(async () => ({
        payment: {
          payment_hash: TEST_PAYMENT_HASH,
          inbound: false,
          amt_msat: 9_007_199_254_740_992,
          status: 'Pending',
        },
      })),
    })
    const unsafe = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      clientFactory: () => unsafeClient,
    })
    await expect(unsafe.lookupPayment({ paymentHash: TEST_PAYMENT_HASH }))
      .rejects.toMatchObject({ code: 'UNKNOWN' })
  })

  it('rejects an outgoing lookup whose preimage does not match the requested payment hash', async () => {
    const client = directClient({
      getPayment: vi.fn(async () => ({
        payment: {
          payment_hash: TEST_PAYMENT_HASH,
          inbound: false,
          status: 'Succeeded',
          preimage: 'aa'.repeat(32),
        },
      })),
    })
    const payments = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      clientFactory: () => client,
    })

    await expect(payments.lookupPayment({ paymentHash: TEST_PAYMENT_HASH }))
      .rejects.toMatchObject({ code: 'UNKNOWN' })
  })

  it('closes the direct client once, clears remembered invoices, and fails closed afterward', async () => {
    const client = directClient()
    const payments = new RlnLightningPayments({
      nodeUrl: 'https://node.example',
      clientFactory: () => client,
    })

    await payments.close()
    await payments.close()
    expect(client.close).toHaveBeenCalledTimes(1)
    await expect(payments.getCapabilities()).rejects.toMatchObject({ code: 'CLOSED' })
  })
})
