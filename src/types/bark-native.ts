import type { BarkBalance } from './bark.js'
export type { BarkBalance } from './bark.js'

/** Host-owned configuration for the on-device Bark wallet. */
export interface BarkReactNativeConfig {
  network: 'mainnet' | 'testnet' | 'signet' | 'regtest'
  serverUrl: string
  esploraUrl: string
  /** Existing app-private directory, as an absolute filesystem path (not a URI). */
  dataDir: string
  /** Read from the host's secure storage; never persisted by the engine. */
  mnemonic: string
  /** Explicit opt-in to creating a wallet. Opening never falls back to recreation. */
  createIfMissing?: boolean
}

export interface BarkArkPaymentRequest {
  address: string
  amountSats: number
  /** Currently rejected: Bark's arkoor API has no enforceable fee-cap parameter. */
  maxFeeSats?: number
}

export interface BarkArkPaymentResult {
  /** The SDK returned successfully; it does not return a payment id or receipt. */
  status: 'submitted'
  address: string
  amountSats: number
}

export interface BarkWalletInfo {
  network: BarkReactNativeConfig['network']
  fingerprint: string
  recovery: 'not-run' | 'complete' | 'incomplete' | 'failed'
}

export type BarkBackendErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_CONNECTED'
  | 'ALREADY_CONNECTED'
  | 'NOT_SUPPORTED'
  | 'SDK_UNAVAILABLE'
  | 'SDK_ERROR'
  | 'PAYMENT_OUTCOME_UNKNOWN'

export class BarkBackendError extends Error {
  constructor(public readonly code: BarkBackendErrorCode, message: string) {
    super(message)
    this.name = 'BarkBackendError'
  }
}

/** Bark movement accounting, without guessing a unified transaction or receipt. */
export interface BarkMovement {
  id: string
  state: string
  kind: string
  intendedBalanceDeltaSats: number
  effectiveBalanceDeltaSats: number
  feeSats: number
  createdAt: string
  completedAt?: string
  paymentHash?: string
  sentToAddresses: string[]
  receivedOnAddresses: string[]
}
