import { describe, expect, it, vi } from 'vitest'

import { NwcLightningPayments } from '../src/lightning/nwc/NwcLightningPayments'
import { bolt11Fixture, TEST_PAYMENT_HASH, TEST_PREIMAGE } from './fixtures/bolt11'

function nwcClient(overrides: Record<string, unknown> = {}) {
  return {
    getInfo: vi.fn(async () => ({
      network: 'regtest',
      pubkey: '02'.padEnd(66, '1'),
      block_height: 321,
      block_hash: 'ab'.repeat(32),
      methods: ['get_info', 'make_invoice', 'pay_invoice', 'lookup_invoice', 'list_transactions'],
    })),
    makeInvoice: vi.fn(),
    payInvoice: vi.fn(),
    lookupInvoice: vi.fn(),
    listTransactions: vi.fn(),
    close: vi.fn(),
    ...overrides,
  }
}

describe('NwcLightningPayments', () => {
  it('normalizes provider-reported network evidence and declares only advertised capabilities', async () => {
    const client = nwcClient()
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://wallet?relay=wss%3A%2F%2Frelay.example&secret=client-secret',
      clientFactory: () => client,
      expectedNetworkId: 'regtest',
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.getNetwork()).resolves.toEqual({
      chain: 'bitcoin',
      networkId: 'regtest',
      nodePubkey: '02'.padEnd(66, '1'),
      blockHeight: 321,
      blockHash: 'ab'.repeat(32),
      evidence: 'provider-reported',
    })
    await expect(payments.getCapabilities()).resolves.toEqual({
      createInvoice: true,
      payInvoice: true,
      lookupInvoice: true,
      lookupPayment: true,
      amountlessInvoices: false,
      maxFeeControl: false,
      idempotencyKeys: false,
      keysend: false,
    })
  })

  it('creates an invoice with an exact safe msat amount and normalizes the signed BOLT11', async () => {
    const invoice = bolt11Fixture({ hrp: 'lnbcrt10n' })
    const client = nwcClient({
      makeInvoice: vi.fn(async () => ({
        type: 'incoming',
        state: 'pending',
        invoice,
        payment_hash: TEST_PAYMENT_HASH,
        amount: 1_000,
      })),
    })
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
      clientFactory: () => client,
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.createInvoice({
      amountMsat: '1000',
      description: 'coffee',
      expirySeconds: 3600,
      requestId: 'invoice-1',
    })).resolves.toEqual({
      bolt11: invoice,
      paymentHash: TEST_PAYMENT_HASH,
      amountMsat: '1000',
      description: 'coffee',
      status: 'unpaid',
      createdAtUnixSeconds: 1_700_000_000,
      expiresAtUnixSeconds: 1_700_003_600,
    })
    expect(client.makeInvoice).toHaveBeenCalledWith({
      amount: 1_000,
      description: 'coffee',
      expiry: 3600,
    })
  })

  it('maps a failed create-invoice provider state to cancelled instead of unpaid', async () => {
    const invoice = bolt11Fixture({ hrp: 'lnbcrt10n' })
    const client = nwcClient({
      makeInvoice: vi.fn(async () => ({ state: 'failed', invoice, amount: 1_000 })),
    })
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
      clientFactory: () => client,
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.createInvoice({ amountMsat: '1000', requestId: 'invoice-failed' }))
      .resolves.toMatchObject({ status: 'cancelled' })
  })

  it('rejects an unsafe msat conversion before calling the NWC SDK', async () => {
    const client = nwcClient()
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
      clientFactory: () => client,
    })

    await expect(payments.createInvoice({
      amountMsat: '9007199254740992',
      requestId: 'invoice-unsafe',
    })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    expect(client.makeInvoice).not.toHaveBeenCalled()
  })

  it('validates network and exact amount before paying an amountless invoice', async () => {
    const invoice = bolt11Fixture({ hrp: 'lnbcrt' })
    const client = nwcClient({
      payInvoice: vi.fn(async () => ({ preimage: TEST_PREIMAGE, fees_paid: 12 })),
    })
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
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
      feeMsat: '12',
      preimage: TEST_PREIMAGE,
      status: 'succeeded',
      settledAtUnixSeconds: 1_700_000_100,
    })
    expect(client.payInvoice).toHaveBeenCalledWith({ invoice, amount: 2_000 })
  })

  it('rejects a fee ceiling before sending because NIP-47 pay_invoice cannot enforce it', async () => {
    const client = nwcClient()
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
      clientFactory: () => client,
    })

    await expect(payments.payInvoice({
      bolt11: bolt11Fixture({ hrp: 'lnbcrt10n' }),
      maxFeeMsat: '10',
      requestId: 'payment-fee',
    })).rejects.toMatchObject({ code: 'MAX_FEE_UNSUPPORTED' })
    expect(client.getInfo).not.toHaveBeenCalled()
    expect(client.payInvoice).not.toHaveBeenCalled()
  })

  it('rejects a payment response whose preimage is not bound to the BOLT11 payment hash', async () => {
    const client = nwcClient({
      payInvoice: vi.fn(async () => ({ preimage: 'aa'.repeat(32) })),
    })
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
      clientFactory: () => client,
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.payInvoice({
      bolt11: bolt11Fixture({ hrp: 'lnbcrt10n' }),
      requestId: 'payment-wrong-preimage',
    })).rejects.toMatchObject({ code: 'PAYMENT_AMBIGUOUS', ambiguous: true })
  })

  it('classifies a malformed fulfilled payment response as non-retryable ambiguity', async () => {
    const client = nwcClient({
      payInvoice: vi.fn(async () => null),
    })
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
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

  it('classifies malformed fields in an otherwise fulfilled payment as ambiguity', async () => {
    const client = nwcClient({
      payInvoice: vi.fn(async () => ({
        preimage: TEST_PREIMAGE,
        fees_paid: 'not-a-safe-msat-number',
      })),
    })
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
      clientFactory: () => client,
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.payInvoice({
      bolt11: bolt11Fixture({ hrp: 'lnbcrt10n' }),
      requestId: 'payment-malformed-fee',
    })).rejects.toMatchObject({
      code: 'PAYMENT_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })
  })

  it('rejects invoice-network and fixed-amount mismatches before sending', async () => {
    const wrongNetworkClient = nwcClient()
    const wrongNetwork = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
      clientFactory: () => wrongNetworkClient,
      nowUnixSeconds: () => 1_700_000_100,
    })
    await expect(wrongNetwork.payInvoice({
      bolt11: bolt11Fixture({ hrp: 'lnbc10n' }),
      requestId: 'payment-network',
    })).rejects.toMatchObject({ code: 'NETWORK_MISMATCH' })
    expect(wrongNetworkClient.payInvoice).not.toHaveBeenCalled()

    const amountClient = nwcClient()
    const wrongAmount = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
      clientFactory: () => amountClient,
      nowUnixSeconds: () => 1_700_000_100,
    })
    await expect(wrongAmount.payInvoice({
      bolt11: bolt11Fixture({ hrp: 'lnbcrt10n' }),
      amountMsat: '2000',
      requestId: 'payment-amount',
    })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    expect(amountClient.payInvoice).not.toHaveBeenCalled()
  })

  it('looks up incoming invoices and outgoing payments by payment hash with normalized states', async () => {
    const invoice = bolt11Fixture({ hrp: 'lnbcrt10n' })
    const client = nwcClient({
      lookupInvoice: vi.fn()
        .mockResolvedValueOnce({
          type: 'incoming',
          state: 'settled',
          invoice,
          payment_hash: TEST_PAYMENT_HASH,
          amount: 1_000,
          settled_at: 1_700_000_200,
        })
        .mockResolvedValueOnce({
          type: 'outgoing',
          state: 'pending',
          invoice,
          payment_hash: TEST_PAYMENT_HASH,
          amount: 1_000,
          fees_paid: 4,
        }),
    })
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
      clientFactory: () => client,
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.lookupInvoice({ paymentHash: TEST_PAYMENT_HASH })).resolves.toMatchObject({
      paymentHash: TEST_PAYMENT_HASH,
      amountMsat: '1000',
      status: 'paid',
      settledAtUnixSeconds: 1_700_000_200,
    })
    await expect(payments.lookupPayment({ paymentHash: TEST_PAYMENT_HASH })).resolves.toEqual({
      paymentHash: TEST_PAYMENT_HASH,
      amountMsat: '1000',
      feeMsat: '4',
      status: 'pending',
      createdAtUnixSeconds: 1_700_000_000,
    })
    expect(client.lookupInvoice).toHaveBeenNthCalledWith(1, { payment_hash: TEST_PAYMENT_HASH })
    expect(client.lookupInvoice).toHaveBeenNthCalledWith(2, { payment_hash: TEST_PAYMENT_HASH })
    expect(client.listTransactions).not.toHaveBeenCalled()
  })

  it('rejects the wrong NWC transaction direction instead of confusing sends and receives', async () => {
    const invoice = bolt11Fixture({ hrp: 'lnbcrt10n' })
    const client = nwcClient({
      lookupInvoice: vi.fn(async () => ({
        type: 'incoming',
        state: 'settled',
        invoice,
        payment_hash: TEST_PAYMENT_HASH,
      })),
    })
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
      clientFactory: () => client,
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.lookupPayment({ paymentHash: TEST_PAYMENT_HASH }))
      .rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' })
  })

  it('rejects an outgoing lookup whose preimage does not match the requested payment hash', async () => {
    const invoice = bolt11Fixture({ hrp: 'lnbcrt10n' })
    const client = nwcClient({
      lookupInvoice: vi.fn(async () => ({
        type: 'outgoing',
        state: 'settled',
        invoice,
        payment_hash: TEST_PAYMENT_HASH,
        preimage: 'aa'.repeat(32),
      })),
    })
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
      clientFactory: () => client,
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.lookupPayment({ paymentHash: TEST_PAYMENT_HASH }))
      .rejects.toMatchObject({ code: 'UNKNOWN' })
  })

  it('never reports a reconciled payment state without provider-bound identity', async () => {
    const client = nwcClient({
      lookupInvoice: vi.fn(async () => ({
        type: 'outgoing',
        state: 'settled',
        amount: 1_000,
      })),
    })
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
      clientFactory: () => client,
    })

    await expect(payments.lookupPayment({ paymentHash: TEST_PAYMENT_HASH }))
      .rejects.toMatchObject({ code: 'UNKNOWN' })
  })

  it('tears down once and maps secret-bearing provider errors without retaining diagnostics', async () => {
    const invoice = bolt11Fixture({ hrp: 'lnbcrt10n' })
    const preimage = 'ef'.repeat(32)
    const connectionUri = 'nostr+walletconnect://wallet?secret=do-not-log'
    const client = nwcClient({
      payInvoice: vi.fn(async () => {
        throw Object.assign(new Error(`${invoice} ${preimage} ${connectionUri}`), { code: 'OTHER' })
      }),
    })
    const payments = new NwcLightningPayments({
      connectionUri,
      clientFactory: () => client,
      nowUnixSeconds: () => 1_700_000_100,
    })

    const error = await payments.payInvoice({
      bolt11: invoice,
      requestId: 'payment-secret-error',
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'PAYMENT_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
      cause: undefined,
    })
    expect(String(error)).not.toContain(invoice)
    expect(String(error)).not.toContain(preimage)
    expect(String(error)).not.toContain(connectionUri)
    expect(JSON.stringify(payments)).not.toContain('do-not-log')

    payments.close()
    payments.close()
    expect(client.close).toHaveBeenCalledTimes(1)
    await expect(payments.getNetwork()).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('enables keysend only when advertised and pays an exact safe amount', async () => {
    const preimage = '01'.repeat(32)
    const client = nwcClient({
      getInfo: vi.fn(async () => ({ network: 'regtest', methods: ['get_info', 'pay_keysend'] })),
      payKeysend: vi.fn(async () => ({ preimage, fees_paid: 3 })),
    })
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
      clientFactory: () => client,
      expectedNetworkId: 'regtest',
      nowUnixSeconds: () => 1_700_000_100,
    })

    await expect(payments.getCapabilities()).resolves.toMatchObject({ keysend: true })
    await expect(payments.payKeysend?.({
      destinationPubkey: `02${'11'.repeat(32)}`,
      amountMsat: '2000',
      requestId: 'keysend-1',
    })).resolves.toMatchObject({
      amountMsat: '2000',
      feeMsat: '3',
      preimage,
      status: 'succeeded',
    })
    expect(client.payKeysend).toHaveBeenCalledWith({
      pubkey: `02${'11'.repeat(32)}`,
      amount: 2_000,
    })
  })

  it('never marks an ambiguous keysend outcome as safe to retry', async () => {
    const client = nwcClient({
      getInfo: vi.fn(async () => ({ network: 'regtest', methods: ['get_info', 'pay_keysend'] })),
      payKeysend: vi.fn(async () => {
        throw new Error('transport failed after dispatch')
      }),
    })
    const payments = new NwcLightningPayments({
      connectionUri: 'nostr+walletconnect://redacted',
      clientFactory: () => client,
    })

    await expect(payments.payKeysend?.({
      destinationPubkey: `02${'11'.repeat(32)}`,
      amountMsat: '2000',
      requestId: 'keysend-ambiguous',
    })).rejects.toMatchObject({
      code: 'PAYMENT_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })
  })
})
