import type { LightningPaymentCapabilities, LightningPayments } from '../types'
import type {
  CreateLightningInvoiceRequest,
  LightningInvoice,
  LightningNetworkIdentity,
  LightningPayment,
  LookupLightningInvoiceRequest,
  LookupLightningPaymentRequest,
  PayLightningInvoiceRequest,
} from '../types'
import { LightningPaymentError } from '../errors'
import { parseMsat, toSafeAmountNumber } from '../amounts'
import { defineLightningCapabilities } from '../types'
import { preimageMatchesPaymentHash } from '../preimages'
import { createDirectRlnNodeClient } from '../../lib/kaleido-client-manager'
import { validateBolt11Invoice } from '../../lib/bolt11'

interface RlnNetworkInfoShape {
  network: string
  height: number
}

interface RlnNodeInfoShape {
  pubkey: string
}

export interface DirectRlnPaymentsClient {
  getNetworkInfo(): Promise<RlnNetworkInfoShape>
  getNodeInfo(): Promise<RlnNodeInfoShape>
  createLNInvoice(body: {
    amt_msat?: number | null
    expiry_sec: number
  }): Promise<unknown>
  getInvoiceStatus(body: { invoice: string }): Promise<unknown>
  sendPayment(body: { invoice: string; amt_msat?: number | null }): Promise<unknown>
  getPayment(body: { payment_hash: string }): Promise<unknown>
}

export interface DirectRlnClientOwner {
  rln: DirectRlnPaymentsClient
  close(): Promise<void>
}

export interface RlnLightningPaymentsOptions {
  nodeUrl: string
  nodeApiKey?: string
  expectedNetworkId?: string
  /** Direct RLN request timeout in seconds, matching kaleido-sdk's KaleidoConfig. */
  timeout?: number
  /** Structural injection seam; the default is the shared credential-safe SDK factory. */
  clientFactory?: (config: {
    nodeUrl: string
    nodeApiKey?: string
    timeoutSeconds?: number
  }) => DirectRlnClientOwner
  nowUnixSeconds?: () => number
}

function canonicalNetworkId(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase().replace(/[-_\s]/g, '')
  switch (normalized) {
    case 'bitcoin':
    case 'mainnet': return 'bitcoin'
    case 'testnet': return 'testnet'
    case 'testnet4': return 'testnet4'
    case 'signet': return 'signet'
    case 'signetcustom': return 'signetcustom'
    case 'regtest': return 'regtest'
    case 'simnet': return 'simnet'
    default:
      throw new LightningPaymentError('NETWORK_MISMATCH', 'RLN provider reported an unsupported Bitcoin network')
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

function normalizedPaymentHash(value: string): string {
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

function positiveExpiry(value: number | undefined): number {
  const resolved = value ?? 3600
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new LightningPaymentError('INVALID_REQUEST', 'expirySeconds must be a positive safe integer')
  }
  return resolved
}

function objectResult(value: unknown, operation: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object') {
    throw new LightningPaymentError('UNKNOWN', `Direct RLN ${operation} returned an invalid response`)
  }
  return value as Record<string, unknown>
}

function safeProviderMsat(value: unknown, field: string): string | undefined {
  if (value == null) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LightningPaymentError('UNKNOWN', `Direct RLN ${field} is not a safe non-negative integer`)
  }
  return String(value)
}

function safeProviderTimestamp(value: unknown, field: string): number | undefined {
  if (value == null) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LightningPaymentError('UNKNOWN', `Direct RLN ${field} is not a safe timestamp`)
  }
  return value as number
}

function mapRlnError(error: unknown, paymentMayHaveStarted = false): LightningPaymentError {
  if (error instanceof LightningPaymentError) return error
  const candidate = error as { code?: unknown; statusCode?: unknown } | null
  const code = candidate != null ? String(candidate.code ?? '') : ''
  const status = candidate != null && typeof candidate.statusCode === 'number'
    ? candidate.statusCode
    : undefined
  if (status === 401 || status === 403 || /AUTH|UNAUTHORIZED|FORBIDDEN/i.test(code)) {
    return new LightningPaymentError('AUTHENTICATION_FAILED', 'Direct RLN node rejected authorization')
  }
  if (status === 404 || /NOT_FOUND/i.test(code)) {
    return new LightningPaymentError('PAYMENT_NOT_FOUND', 'Direct RLN payment was not found')
  }
  if (paymentMayHaveStarted) {
    return new LightningPaymentError(
      'PAYMENT_AMBIGUOUS',
      'Direct RLN payment outcome is ambiguous; reconcile by payment hash',
      { ambiguous: true },
    )
  }
  return new LightningPaymentError('PROVIDER_UNAVAILABLE', 'Direct RLN provider request failed', {
    retryable: status == null || status >= 500,
  })
}

const CAPABILITIES = defineLightningCapabilities({
  createInvoice: true,
  payInvoice: true,
  // The direct API requires the original BOLT11. This adapter remembers it
  // only for its own lifetime, so lookup is not a durable advertised feature.
  lookupInvoice: false,
  lookupPayment: true,
  amountlessInvoices: true,
  maxFeeControl: false,
  idempotencyKeys: false,
  keysend: false,
})

export class RlnLightningPayments implements LightningPayments {
  readonly #client: DirectRlnClientOwner
  readonly #expectedNetworkId?: string
  readonly #nowUnixSeconds: () => number
  readonly #invoices = new Map<string, string>()
  #closed = false

  constructor(options: RlnLightningPaymentsOptions) {
    if (typeof options.nodeUrl !== 'string' || options.nodeUrl.length === 0) {
      throw new LightningPaymentError('INVALID_REQUEST', 'Direct RLN nodeUrl is required')
    }
    const factory = options.clientFactory ?? ((config) => createDirectRlnNodeClient(config))
    try {
      this.#client = factory({
        nodeUrl: options.nodeUrl,
        ...(options.nodeApiKey != null ? { nodeApiKey: options.nodeApiKey } : {}),
        ...(options.timeout != null ? { timeoutSeconds: options.timeout } : {}),
      })
    } catch {
      throw new LightningPaymentError('INVALID_REQUEST', 'Direct RLN client configuration is invalid')
    }
    this.#expectedNetworkId = options.expectedNetworkId == null
      ? undefined
      : canonicalNetworkId(options.expectedNetworkId)
    this.#nowUnixSeconds = options.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1000))
  }

  #assertOpen(): void {
    if (this.#closed) throw new LightningPaymentError('CLOSED', 'Direct RLN payments adapter is closed')
  }

  async getNetwork(): Promise<LightningNetworkIdentity> {
    this.#assertOpen()
    let networkInfo: RlnNetworkInfoShape
    let nodeInfo: RlnNodeInfoShape
    try {
      ;[networkInfo, nodeInfo] = await Promise.all([
        this.#client.rln.getNetworkInfo(),
        this.#client.rln.getNodeInfo(),
      ])
    } catch {
      throw new LightningPaymentError('PROVIDER_UNAVAILABLE', 'Direct RLN network information is unavailable', {
        retryable: true,
      })
    }
    const networkId = canonicalNetworkId(networkInfo.network)
    if (this.#expectedNetworkId != null && networkId !== this.#expectedNetworkId) {
      throw new LightningPaymentError('NETWORK_MISMATCH', 'Direct RLN network does not match configuration')
    }
    return {
      chain: 'bitcoin',
      networkId,
      ...(typeof nodeInfo.pubkey === 'string' ? { nodePubkey: nodeInfo.pubkey } : {}),
      ...(Number.isSafeInteger(networkInfo.height) && networkInfo.height >= 0
        ? { blockHeight: networkInfo.height }
        : {}),
      evidence: 'provider-reported',
    }
  }

  async getCapabilities(): Promise<Readonly<LightningPaymentCapabilities>> {
    this.#assertOpen()
    return CAPABILITIES
  }

  async createInvoice(_request: CreateLightningInvoiceRequest): Promise<LightningInvoice> {
    this.#assertOpen()
    const request = _request
    requiredRequestId(request.requestId)
    if (request.description != null) {
      throw new LightningPaymentError(
        'METHOD_UNSUPPORTED',
        'kaleido-sdk 0.1.17 direct RLN invoice creation has no description field',
      )
    }
    const amount = request.amountMsat == null ? undefined : safePositiveMsat(request.amountMsat)
    const expiry = positiveExpiry(request.expirySeconds)
    const network = await this.getNetwork()
    let raw: Record<string, unknown>
    try {
      raw = objectResult(await this.#client.rln.createLNInvoice({
        ...(amount != null ? { amt_msat: amount } : {}),
        expiry_sec: expiry,
      }), 'invoice creation')
    } catch (error) {
      throw mapRlnError(error)
    }
    if (typeof raw.invoice !== 'string') {
      throw new LightningPaymentError('UNKNOWN', 'Direct RLN invoice creation returned no BOLT11 invoice')
    }
    const decoded = validateBolt11Invoice(raw.invoice, {
      allowedHrps: allowedHrps(network.networkId),
      nowUnixSeconds: this.#nowUnixSeconds(),
    })
    if (decoded.amountMsat !== request.amountMsat) {
      throw new LightningPaymentError('INVALID_AMOUNT', 'Direct RLN invoice does not match the requested amount')
    }
    this.#invoices.set(decoded.paymentHash, raw.invoice)
    return {
      bolt11: raw.invoice,
      paymentHash: decoded.paymentHash,
      ...(decoded.amountMsat != null ? { amountMsat: decoded.amountMsat } : {}),
      status: 'unpaid',
      createdAtUnixSeconds: decoded.createdAtUnixSeconds,
      expiresAtUnixSeconds: decoded.expiresAtUnixSeconds,
    }
  }

  async payInvoice(_request: PayLightningInvoiceRequest): Promise<LightningPayment> {
    this.#assertOpen()
    const request = _request
    if (request.maxFeeMsat != null) {
      throw new LightningPaymentError(
        'MAX_FEE_UNSUPPORTED',
        'kaleido-sdk 0.1.17 direct RLN sendPayment cannot enforce a per-payment fee ceiling',
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
    try {
      raw = objectResult(await this.#client.rln.sendPayment({
        invoice: request.bolt11,
        ...(amount != null ? { amt_msat: amount } : {}),
      }), 'invoice payment')
    } catch (error) {
      throw mapRlnError(error, true)
    }
    if (raw.payment_hash != null && raw.payment_hash !== decoded.paymentHash) {
      throw new LightningPaymentError(
        'PAYMENT_AMBIGUOUS',
        'Direct RLN returned a mismatched payment identity; reconcile by BOLT11 payment hash',
        { ambiguous: true },
      )
    }
    const providerStatus = typeof raw.status === 'string' ? raw.status.toLowerCase() : ''
    const status = providerStatus === 'succeeded'
      ? 'succeeded'
      : providerStatus === 'failed'
        ? 'failed'
        : providerStatus === 'pending'
          ? 'pending'
          : 'unknown'
    return {
      paymentHash: decoded.paymentHash,
      ...(amountMsat != null ? { amountMsat } : {}),
      status,
      ...(status === 'succeeded' ? { settledAtUnixSeconds: this.#nowUnixSeconds() } : {}),
      ...(status === 'failed' ? { failureReason: 'Direct RLN provider reported payment failure' } : {}),
    }
  }

  /** Best-effort lookup for invoices created during this adapter instance's lifetime. */
  async lookupInvoice(_request: LookupLightningInvoiceRequest): Promise<LightningInvoice> {
    this.#assertOpen()
    const requestedHash = normalizedPaymentHash(_request.paymentHash)
    const invoice = this.#invoices.get(requestedHash)
    if (invoice == null) {
      throw new LightningPaymentError(
        'PAYMENT_NOT_FOUND',
        'Direct RLN can look up only invoices created by this adapter instance',
      )
    }
    const network = await this.getNetwork()
    let raw: Record<string, unknown>
    try {
      raw = objectResult(
        await this.#client.rln.getInvoiceStatus({ invoice }),
        'invoice lookup',
      )
    } catch (error) {
      throw mapRlnError(error)
    }
    const decoded = validateBolt11Invoice(invoice, {
      allowedHrps: allowedHrps(network.networkId),
      nowUnixSeconds: this.#nowUnixSeconds(),
      allowExpired: true,
    })
    const status = typeof raw.status === 'string' ? raw.status.toLowerCase() : ''
    return {
      bolt11: invoice,
      paymentHash: decoded.paymentHash,
      ...(decoded.amountMsat != null ? { amountMsat: decoded.amountMsat } : {}),
      status: status === 'succeeded'
        ? 'paid'
        : status === 'failed'
          ? 'cancelled'
          : status === 'expired'
            ? 'expired'
            : status === 'pending'
              ? 'unpaid'
              : 'unknown',
      createdAtUnixSeconds: decoded.createdAtUnixSeconds,
      expiresAtUnixSeconds: decoded.expiresAtUnixSeconds,
    }
  }

  async lookupPayment(_request: LookupLightningPaymentRequest): Promise<LightningPayment> {
    this.#assertOpen()
    const requestedHash = normalizedPaymentHash(_request.paymentHash)
    await this.getNetwork()
    let wrapper: Record<string, unknown>
    try {
      wrapper = objectResult(
        await this.#client.rln.getPayment({ payment_hash: requestedHash }),
        'payment lookup',
      )
    } catch (error) {
      throw mapRlnError(error)
    }
    const raw = objectResult(wrapper.payment, 'payment lookup')
    if (raw.inbound === true) {
      throw new LightningPaymentError('PAYMENT_NOT_FOUND', 'Direct RLN lookup returned an inbound payment')
    }
    if (raw.inbound !== false || raw.payment_hash !== requestedHash) {
      throw new LightningPaymentError('UNKNOWN', 'Direct RLN payment identity or direction is invalid')
    }
    const amountMsat = safeProviderMsat(raw.amt_msat, 'amt_msat')
    const createdAtUnixSeconds = safeProviderTimestamp(raw.created_at, 'created_at')
    const updatedAtUnixSeconds = safeProviderTimestamp(raw.updated_at, 'updated_at')
    const providerStatus = typeof raw.status === 'string' ? raw.status.toLowerCase() : ''
    const status = providerStatus === 'succeeded'
      ? 'succeeded'
      : providerStatus === 'failed'
        ? 'failed'
        : providerStatus === 'pending'
          ? 'pending'
          : 'unknown'
    let preimage: string | undefined
    if (raw.preimage != null) {
      if (!preimageMatchesPaymentHash(raw.preimage, requestedHash)) {
        throw new LightningPaymentError('UNKNOWN', 'Direct RLN payment preimage does not match the lookup')
      }
      preimage = raw.preimage
    }
    return {
      paymentHash: requestedHash,
      ...(amountMsat != null ? { amountMsat } : {}),
      ...(preimage != null ? { preimage } : {}),
      status,
      ...(createdAtUnixSeconds != null ? { createdAtUnixSeconds } : {}),
      ...(status === 'succeeded' && updatedAtUnixSeconds != null
        ? { settledAtUnixSeconds: updatedAtUnixSeconds }
        : {}),
      ...(status === 'failed' ? { failureReason: 'Direct RLN provider reported payment failure' } : {}),
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#invoices.clear()
    await this.#client.close()
  }
}
