import type { MillisatoshiAmount } from './amounts'

export type LightningNetworkEvidence = 'provider-reported' | 'chain-verified'

export interface LightningNetworkIdentity {
  chain: 'bitcoin'
  /** Provider network identifier, for example bitcoin, testnet, signetcustom, or regtest. */
  networkId: string
  nodePubkey?: string
  blockHeight?: number
  blockHash?: string
  evidence: LightningNetworkEvidence
}

export interface LightningPaymentCapabilities {
  createInvoice: boolean
  payInvoice: boolean
  lookupInvoice: boolean
  lookupPayment: boolean
  amountlessInvoices: boolean
  /** Whether a fee ceiling can be enforced for each individual payment. */
  maxFeeControl: boolean
  idempotencyKeys: boolean
  /** Explicitly false when the provider cannot make keysend payments. */
  keysend: boolean
}

const CAPABILITY_FIELDS = [
  'createInvoice',
  'payInvoice',
  'lookupInvoice',
  'lookupPayment',
  'amountlessInvoices',
  'maxFeeControl',
  'idempotencyKeys',
  'keysend',
] as const satisfies readonly (keyof LightningPaymentCapabilities)[]

/** Runtime companion to the compile-time capability contract. */
export function defineLightningCapabilities(
  capabilities: LightningPaymentCapabilities,
): Readonly<LightningPaymentCapabilities> {
  for (const field of CAPABILITY_FIELDS) {
    if (typeof capabilities?.[field] !== 'boolean') {
      throw new TypeError(`Lightning capability ${field} must be an explicit boolean`)
    }
  }
  return Object.freeze({
    createInvoice: capabilities.createInvoice,
    payInvoice: capabilities.payInvoice,
    lookupInvoice: capabilities.lookupInvoice,
    lookupPayment: capabilities.lookupPayment,
    amountlessInvoices: capabilities.amountlessInvoices,
    maxFeeControl: capabilities.maxFeeControl,
    idempotencyKeys: capabilities.idempotencyKeys,
    keysend: capabilities.keysend,
  })
}

export type LightningPaymentState =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'not-found'
  | 'unknown'

export type LightningPaymentStatus = LightningPaymentState

export type LightningInvoiceStatus =
  | 'unpaid'
  | 'paid'
  | 'expired'
  | 'cancelled'
  | 'not-found'
  | 'unknown'

export interface CreateLightningInvoiceRequest {
  /** Omit only when requesting an amountless invoice. */
  amountMsat?: MillisatoshiAmount
  description?: string
  expirySeconds?: number
  /** Caller-generated correlation/idempotency key. */
  requestId: string
}

export interface PayLightningInvoiceRequest {
  bolt11: string
  /** Required only when paying an amountless BOLT11 invoice. */
  amountMsat?: MillisatoshiAmount
  /** Strict per-payment routing-fee ceiling; never a best-effort hint. */
  maxFeeMsat?: MillisatoshiAmount
  /** Caller-generated correlation/idempotency key. */
  requestId: string
}

export interface LightningKeysendRequest {
  destinationPubkey: string
  amountMsat: MillisatoshiAmount
  maxFeeMsat?: MillisatoshiAmount
  requestId: string
}

export interface LookupLightningInvoiceRequest {
  paymentHash: string
}

export interface LookupLightningPaymentRequest {
  paymentHash: string
}

export interface LightningInvoice {
  bolt11: string
  paymentHash: string
  amountMsat?: MillisatoshiAmount
  description?: string
  status: LightningInvoiceStatus
  createdAtUnixSeconds: number
  expiresAtUnixSeconds: number
  settledAtUnixSeconds?: number
}

export interface LightningPayment {
  paymentHash: string
  amountMsat?: MillisatoshiAmount
  feeMsat?: MillisatoshiAmount
  preimage?: string
  status: LightningPaymentStatus
  createdAtUnixSeconds?: number
  settledAtUnixSeconds?: number
  /** Sanitized provider-independent failure description. */
  failureReason?: string
}

export type CreateLightningInvoiceResult = LightningInvoice
export type PayLightningInvoiceResult = LightningPayment
export type LookupLightningInvoiceResult = LightningInvoice
export type LookupLightningPaymentResult = LightningPayment
export type LightningKeysendResult = LightningPayment

/** SDK-free payment capability implemented by opt-in transports. */
export interface LightningPayments {
  getNetwork(): Promise<LightningNetworkIdentity>
  getCapabilities(): Promise<Readonly<LightningPaymentCapabilities>>
  createInvoice(request: CreateLightningInvoiceRequest): Promise<CreateLightningInvoiceResult>
  payInvoice(request: PayLightningInvoiceRequest): Promise<PayLightningInvoiceResult>
  lookupInvoice(request: LookupLightningInvoiceRequest): Promise<LookupLightningInvoiceResult>
  lookupPayment(request: LookupLightningPaymentRequest): Promise<LookupLightningPaymentResult>
  /** Present only when `getCapabilities().keysend` is true. */
  payKeysend?(request: LightningKeysendRequest): Promise<LightningKeysendResult>
  close(): void | Promise<void>
}
