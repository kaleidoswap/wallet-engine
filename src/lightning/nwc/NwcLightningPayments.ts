import { NWCClient } from 'kaleido-sdk/nwc'

import { parseMsat, toSafeAmountNumber } from '../amounts'
import { LightningPaymentError } from '../errors'
import {
  isLightningPreimage,
  paymentHashFromPreimage,
  preimageMatchesPaymentHash,
} from '../preimages'
import { defineLightningCapabilities } from '../types'
import { validateBolt11Invoice } from '../../lib/bolt11'
import type {
  CreateLightningInvoiceRequest,
  LightningInvoice,
  LightningKeysendRequest,
  LightningNetworkIdentity,
  LightningPayment,
  LightningPaymentCapabilities,
  LightningPayments,
  LookupLightningInvoiceRequest,
  LookupLightningPaymentRequest,
  PayLightningInvoiceRequest,
} from '../types'

interface NwcInfoShape {
  network?: string
  pubkey?: string
  block_height?: number
  block_hash?: string
  methods: string[]
}

export interface NwcPaymentsClient {
  getInfo(): Promise<NwcInfoShape>
  makeInvoice(params: { amount: number; description?: string; expiry?: number }): Promise<unknown>
  payInvoice(params: { invoice: string; amount?: number }): Promise<unknown>
  lookupInvoice(params: { payment_hash?: string; invoice?: string }): Promise<unknown>
  listTransactions(params?: {
    type?: 'incoming' | 'outgoing'
    limit?: number
    offset?: number
  }): Promise<unknown[]>
  payKeysend?(params: { amount: number; pubkey: string }): Promise<unknown>
  close(): void
}

export interface NwcLightningPaymentsOptions {
  /** NIP-47 connection URI. It is passed straight to the SDK and is never retained separately. */
  connectionUri: string
  expectedNetworkId?: string
  requestTimeoutMs?: number
  /** Structural injection seam for tests and host-managed NWC clients; no SDK type crosses the API. */
  clientFactory?: (connectionUri: string, options: { timeoutMs?: number }) => NwcPaymentsClient
  /** Deterministic clock seam. */
  nowUnixSeconds?: () => number
}

function canonicalNetworkId(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase().replace(/[-_\s]/g, '')
  switch (normalized) {
    case 'bitcoin':
    case 'mainnet':
      return 'bitcoin'
    case 'testnet':
      return 'testnet'
    case 'testnet4':
      return 'testnet4'
    case 'signet':
      return 'signet'
    case 'signetcustom':
      return 'signetcustom'
    case 'regtest':
      return 'regtest'
    case 'simnet':
      return 'simnet'
    default:
      throw new LightningPaymentError(
        'NETWORK_MISMATCH',
        'NWC provider did not report a supported Bitcoin network',
      )
  }
}

function allowedHrps(networkId: string): readonly ('bc' | 'tb' | 'tbs' | 'bcrt' | 'sb')[] {
  switch (networkId) {
    case 'bitcoin': return ['bc']
    case 'testnet':
    case 'testnet4': return ['tb']
    case 'signet':
    case 'signetcustom': return ['tb', 'tbs']
    case 'regtest': return ['bcrt']
    case 'simnet': return ['sb']
    default: throw new LightningPaymentError('NETWORK_MISMATCH', 'Unsupported Bitcoin network')
  }
}

function requiredRequestId(requestId: string): void {
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new LightningPaymentError('INVALID_REQUEST', 'requestId must be a non-empty string')
  }
}

function paymentHash(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new LightningPaymentError('INVALID_REQUEST', 'paymentHash must be 32-byte hexadecimal')
  }
  return value.toLowerCase()
}

function safePositiveMsat(value: string): number {
  try {
    if (parseMsat(value) === 0n) throw new RangeError('zero')
    return toSafeAmountNumber(value, 'msat')
  } catch {
    throw new LightningPaymentError('INVALID_AMOUNT', 'msat amount must be positive and safely representable')
  }
}

function expirySeconds(value: number | undefined): number | undefined {
  if (value == null) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LightningPaymentError('INVALID_REQUEST', 'expirySeconds must be a positive safe integer')
  }
  return value
}

function objectResult(value: unknown, operation: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object') {
    throw new LightningPaymentError('UNKNOWN', `NWC ${operation} returned an invalid response`)
  }
  return value as Record<string, unknown>
}

function safeProviderMsat(value: unknown, field: string): string | undefined {
  if (value == null) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LightningPaymentError('UNKNOWN', `NWC ${field} is not a safe non-negative integer`)
  }
  return String(value)
}

function mapNwcError(error: unknown, paymentMayHaveStarted = false): LightningPaymentError {
  if (error instanceof LightningPaymentError) {
    if (paymentMayHaveStarted && error.code === 'UNKNOWN') {
      return new LightningPaymentError(
        'PAYMENT_AMBIGUOUS',
        'NWC payment returned an invalid response; reconcile by payment hash',
        { ambiguous: true },
      )
    }
    return error
  }
  const code = error != null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
  switch (code) {
    case 'UNAUTHORIZED':
    case 'RESTRICTED':
      return new LightningPaymentError('AUTHENTICATION_FAILED', 'NWC provider rejected authorization')
    case 'NOT_IMPLEMENTED':
      return new LightningPaymentError('METHOD_UNSUPPORTED', 'NWC provider does not support this method')
    case 'NOT_FOUND':
      return new LightningPaymentError('PAYMENT_NOT_FOUND', 'NWC payment was not found')
    case 'PAYMENT_FAILED':
    case 'INSUFFICIENT_BALANCE':
    case 'QUOTA_EXCEEDED':
      return new LightningPaymentError('PAYMENT_FAILED', 'NWC provider rejected the payment')
    case 'RATE_LIMITED':
      return new LightningPaymentError('PROVIDER_UNAVAILABLE', 'NWC provider rate limit was reached', {
        retryable: true,
      })
    default:
      return paymentMayHaveStarted
        ? new LightningPaymentError(
          'PAYMENT_AMBIGUOUS',
          'NWC payment outcome is ambiguous; reconcile by payment hash',
          { ambiguous: true },
        )
        : new LightningPaymentError('PROVIDER_UNAVAILABLE', 'NWC provider request failed', {
          retryable: true,
        })
  }
}

export class NwcLightningPayments implements LightningPayments {
  readonly #client: NwcPaymentsClient
  readonly #expectedNetworkId?: string
  readonly #nowUnixSeconds: () => number
  #closed = false

  constructor(options: NwcLightningPaymentsOptions) {
    const factory = options.clientFactory ?? ((uri, clientOptions) => new NWCClient(uri, clientOptions))
    try {
      this.#client = factory(options.connectionUri, { timeoutMs: options.requestTimeoutMs })
    } catch {
      throw new LightningPaymentError('INVALID_REQUEST', 'NWC connection configuration is invalid')
    }
    this.#expectedNetworkId = options.expectedNetworkId == null
      ? undefined
      : canonicalNetworkId(options.expectedNetworkId)
    this.#nowUnixSeconds = options.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1000))
  }

  #assertOpen(): void {
    if (this.#closed) throw new LightningPaymentError('CLOSED', 'NWC payments adapter is closed')
  }

  async #getInfo(): Promise<NwcInfoShape> {
    this.#assertOpen()
    try {
      return await this.#client.getInfo()
    } catch (error) {
      throw mapNwcError(error)
    }
  }

  async getNetwork(): Promise<LightningNetworkIdentity> {
    const info = await this.#getInfo()
    const networkId = canonicalNetworkId(info.network)
    if (this.#expectedNetworkId != null && networkId !== this.#expectedNetworkId) {
      throw new LightningPaymentError('NETWORK_MISMATCH', 'NWC provider network does not match configuration')
    }
    return {
      chain: 'bitcoin',
      networkId,
      ...(info.pubkey != null ? { nodePubkey: info.pubkey } : {}),
      ...(Number.isSafeInteger(info.block_height) && (info.block_height ?? -1) >= 0
        ? { blockHeight: info.block_height }
        : {}),
      ...(info.block_hash != null ? { blockHash: info.block_hash } : {}),
      evidence: 'provider-reported',
    }
  }

  async getCapabilities(): Promise<Readonly<LightningPaymentCapabilities>> {
    const methods = new Set((await this.#getInfo()).methods)
    return defineLightningCapabilities({
      createInvoice: methods.has('make_invoice'),
      payInvoice: methods.has('pay_invoice'),
      lookupInvoice: methods.has('lookup_invoice'),
      lookupPayment: methods.has('lookup_invoice'),
      amountlessInvoices: false,
      maxFeeControl: false,
      idempotencyKeys: false,
      keysend: methods.has('pay_keysend') && typeof this.#client.payKeysend === 'function',
    })
  }

  async createInvoice(_request: CreateLightningInvoiceRequest): Promise<LightningInvoice> {
    this.#assertOpen()
    const request = _request
    requiredRequestId(request.requestId)
    if (request.amountMsat == null) {
      throw new LightningPaymentError(
        'AMOUNT_REQUIRED',
        'kaleido-sdk 0.1.17 requires an amount for NIP-47 make_invoice',
      )
    }
    const amount = safePositiveMsat(request.amountMsat)
    const expiry = expirySeconds(request.expirySeconds)
    const network = await this.getNetwork()

    let raw: Record<string, unknown>
    try {
      raw = objectResult(await this.#client.makeInvoice({
        amount,
        ...(request.description != null ? { description: request.description } : {}),
        ...(expiry != null ? { expiry } : {}),
      }), 'invoice creation')
    } catch (error) {
      throw mapNwcError(error)
    }

    if (typeof raw.invoice !== 'string') {
      throw new LightningPaymentError('UNKNOWN', 'NWC invoice creation returned no BOLT11 invoice')
    }
    const decoded = validateBolt11Invoice(raw.invoice, {
      allowedHrps: allowedHrps(network.networkId),
      nowUnixSeconds: this.#nowUnixSeconds(),
    })
    if (decoded.amountMsat !== request.amountMsat ||
        (raw.payment_hash != null && raw.payment_hash !== decoded.paymentHash) ||
        (raw.amount != null && raw.amount !== amount)) {
      throw new LightningPaymentError('INVALID_AMOUNT', 'NWC invoice does not match the requested amount or identity')
    }

    return {
      bolt11: raw.invoice,
      paymentHash: decoded.paymentHash,
      amountMsat: decoded.amountMsat,
      ...(request.description != null ? { description: request.description } : {}),
      status: raw.state === 'settled'
        ? 'paid'
        : raw.state === 'expired'
          ? 'expired'
          : raw.state === 'failed'
            ? 'cancelled'
            : raw.state === 'pending'
              ? 'unpaid'
              : 'unknown',
      createdAtUnixSeconds: decoded.createdAtUnixSeconds,
      expiresAtUnixSeconds: decoded.expiresAtUnixSeconds,
      ...(Number.isSafeInteger(raw.settled_at) && (raw.settled_at as number) >= 0
        ? { settledAtUnixSeconds: raw.settled_at as number }
        : {}),
    }
  }

  async payInvoice(_request: PayLightningInvoiceRequest): Promise<LightningPayment> {
    this.#assertOpen()
    const request = _request
    if (request.maxFeeMsat != null) {
      throw new LightningPaymentError(
        'MAX_FEE_UNSUPPORTED',
        'kaleido-sdk 0.1.17 NIP-47 pay_invoice cannot enforce a per-payment fee ceiling',
      )
    }
    requiredRequestId(request.requestId)
    const network = await this.getNetwork()
    const decoded = validateBolt11Invoice(request.bolt11, {
      allowedHrps: allowedHrps(network.networkId),
      nowUnixSeconds: this.#nowUnixSeconds(),
    })

    let amount: number | undefined
    let amountMsat = decoded.amountMsat
    if (decoded.amountMsat == null) {
      if (request.amountMsat == null) {
        throw new LightningPaymentError('AMOUNT_REQUIRED', 'Amountless BOLT11 payment requires amountMsat')
      }
      amount = safePositiveMsat(request.amountMsat)
      amountMsat = request.amountMsat
    } else if (request.amountMsat != null) {
      try {
        parseMsat(request.amountMsat)
      } catch {
        throw new LightningPaymentError('INVALID_AMOUNT', 'Payment amount is not canonical')
      }
      if (request.amountMsat !== decoded.amountMsat) {
        throw new LightningPaymentError('INVALID_AMOUNT', 'Payment amount does not exactly match the BOLT11 invoice')
      }
    }

    let raw: Record<string, unknown>
    let feeMsat: string | undefined
    try {
      raw = objectResult(await this.#client.payInvoice({
        invoice: request.bolt11,
        ...(amount != null ? { amount } : {}),
      }), 'invoice payment')
      if (!preimageMatchesPaymentHash(raw.preimage, decoded.paymentHash)) {
        throw new LightningPaymentError(
          'PAYMENT_AMBIGUOUS',
          'NWC payment returned no preimage bound to the invoice; reconcile by payment hash',
          { ambiguous: true },
        )
      }
      feeMsat = safeProviderMsat(raw.fees_paid, 'fees_paid')
    } catch (error) {
      throw mapNwcError(error, true)
    }

    return {
      paymentHash: decoded.paymentHash,
      ...(amountMsat != null ? { amountMsat } : {}),
      ...(feeMsat != null ? { feeMsat } : {}),
      preimage: raw.preimage,
      status: 'succeeded',
      settledAtUnixSeconds: this.#nowUnixSeconds(),
    }
  }

  async lookupInvoice(_request: LookupLightningInvoiceRequest): Promise<LightningInvoice> {
    this.#assertOpen()
    const requestedHash = paymentHash(_request.paymentHash)
    const network = await this.getNetwork()
    let raw: Record<string, unknown>
    try {
      raw = objectResult(
        await this.#client.lookupInvoice({ payment_hash: requestedHash }),
        'invoice lookup',
      )
    } catch (error) {
      throw mapNwcError(error)
    }
    if (raw.type != null && raw.type !== 'incoming') {
      throw new LightningPaymentError('PAYMENT_NOT_FOUND', 'NWC lookup did not return an incoming invoice')
    }
    if (typeof raw.invoice !== 'string') {
      throw new LightningPaymentError('UNKNOWN', 'NWC invoice lookup returned no BOLT11 invoice')
    }
    const decoded = validateBolt11Invoice(raw.invoice, {
      allowedHrps: allowedHrps(network.networkId),
      nowUnixSeconds: this.#nowUnixSeconds(),
      allowExpired: true,
    })
    if ((raw.payment_hash != null && raw.payment_hash !== decoded.paymentHash) ||
        decoded.paymentHash !== requestedHash) {
      throw new LightningPaymentError('UNKNOWN', 'NWC invoice identity does not match the lookup')
    }
    const providerAmount = safeProviderMsat(raw.amount, 'amount')
    if (providerAmount != null && decoded.amountMsat != null && providerAmount !== decoded.amountMsat) {
      throw new LightningPaymentError('INVALID_AMOUNT', 'NWC invoice amount does not match its BOLT11')
    }

    return {
      bolt11: raw.invoice,
      paymentHash: decoded.paymentHash,
      ...((decoded.amountMsat ?? providerAmount) != null
        ? { amountMsat: decoded.amountMsat ?? providerAmount }
        : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      status: raw.state === 'settled'
        ? 'paid'
        : raw.state === 'expired'
          ? 'expired'
          : raw.state === 'failed'
            ? 'cancelled'
            : raw.state === 'pending'
              ? 'unpaid'
              : 'unknown',
      createdAtUnixSeconds: decoded.createdAtUnixSeconds,
      expiresAtUnixSeconds: decoded.expiresAtUnixSeconds,
      ...(Number.isSafeInteger(raw.settled_at) && (raw.settled_at as number) >= 0
        ? { settledAtUnixSeconds: raw.settled_at as number }
        : {}),
    }
  }

  async lookupPayment(_request: LookupLightningPaymentRequest): Promise<LightningPayment> {
    this.#assertOpen()
    const requestedHash = paymentHash(_request.paymentHash)
    const network = await this.getNetwork()
    let raw: Record<string, unknown>
    try {
      raw = objectResult(
        await this.#client.lookupInvoice({ payment_hash: requestedHash }),
        'payment lookup',
      )
    } catch (error) {
      throw mapNwcError(error)
    }
    if (raw.type != null && raw.type !== 'outgoing') {
      throw new LightningPaymentError('PAYMENT_NOT_FOUND', 'NWC lookup did not return an outgoing payment')
    }

    let createdAtUnixSeconds: number | undefined
    let invoiceAmount: string | undefined
    if (typeof raw.invoice === 'string') {
      const decoded = validateBolt11Invoice(raw.invoice, {
        allowedHrps: allowedHrps(network.networkId),
        nowUnixSeconds: this.#nowUnixSeconds(),
        allowExpired: true,
      })
      if (decoded.paymentHash !== requestedHash) {
        throw new LightningPaymentError('UNKNOWN', 'NWC payment BOLT11 does not match the lookup')
      }
      invoiceAmount = decoded.amountMsat
      createdAtUnixSeconds = decoded.createdAtUnixSeconds
    }
    if (raw.payment_hash !== requestedHash) {
      throw new LightningPaymentError('UNKNOWN', 'NWC payment identity does not match the lookup')
    }
    const providerAmount = safeProviderMsat(raw.amount, 'amount')
    if (providerAmount != null && invoiceAmount != null && providerAmount !== invoiceAmount) {
      throw new LightningPaymentError('INVALID_AMOUNT', 'NWC payment amount does not match its BOLT11')
    }
    let preimage: string | undefined
    if (raw.preimage != null) {
      if (!preimageMatchesPaymentHash(raw.preimage, requestedHash)) {
        throw new LightningPaymentError('UNKNOWN', 'NWC payment preimage does not match the lookup')
      }
      preimage = raw.preimage
    }

    return {
      paymentHash: requestedHash,
      ...((invoiceAmount ?? providerAmount) != null ? { amountMsat: invoiceAmount ?? providerAmount } : {}),
      ...(raw.fees_paid != null ? { feeMsat: safeProviderMsat(raw.fees_paid, 'fees_paid') } : {}),
      ...(preimage != null ? { preimage } : {}),
      status: raw.state === 'settled'
        ? 'succeeded'
        : raw.state === 'failed' || raw.state === 'expired'
          ? 'failed'
          : raw.state === 'pending'
            ? 'pending'
            : 'unknown',
      ...(createdAtUnixSeconds != null ? { createdAtUnixSeconds } : {}),
      ...(Number.isSafeInteger(raw.settled_at) && (raw.settled_at as number) >= 0
        ? { settledAtUnixSeconds: raw.settled_at as number }
        : {}),
      ...(raw.state === 'failed' || raw.state === 'expired'
        ? { failureReason: 'NWC provider reported payment failure' }
        : {}),
    }
  }

  async payKeysend(request: LightningKeysendRequest): Promise<LightningPayment> {
    this.#assertOpen()
    if (request.maxFeeMsat != null) {
      throw new LightningPaymentError(
        'MAX_FEE_UNSUPPORTED',
        'kaleido-sdk 0.1.17 NIP-47 pay_keysend cannot enforce a per-payment fee ceiling',
      )
    }
    requiredRequestId(request.requestId)
    if (!/^(02|03)[0-9a-f]{64}$/i.test(request.destinationPubkey)) {
      throw new LightningPaymentError('INVALID_REQUEST', 'Keysend destination must be a compressed node pubkey')
    }
    const amount = safePositiveMsat(request.amountMsat)
    await this.getNetwork()
    if (typeof this.#client.payKeysend !== 'function') {
      throw new LightningPaymentError('METHOD_UNSUPPORTED', 'NWC provider does not support keysend')
    }

    let raw: Record<string, unknown>
    let feeMsat: string | undefined
    try {
      raw = objectResult(await this.#client.payKeysend({
        amount,
        pubkey: request.destinationPubkey,
      }), 'keysend payment')
      if (!isLightningPreimage(raw.preimage)) {
        throw new LightningPaymentError(
          'PAYMENT_AMBIGUOUS',
          'NWC keysend returned no valid preimage',
          { ambiguous: true },
        )
      }
      feeMsat = safeProviderMsat(raw.fees_paid, 'fees_paid')
    } catch (error) {
      throw mapNwcError(error, true)
    }
    return {
      paymentHash: paymentHashFromPreimage(raw.preimage),
      amountMsat: request.amountMsat,
      ...(feeMsat != null ? { feeMsat } : {}),
      preimage: raw.preimage,
      status: 'succeeded',
      settledAtUnixSeconds: this.#nowUnixSeconds(),
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#client.close()
  }
}
