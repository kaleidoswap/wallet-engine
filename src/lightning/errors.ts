export type LightningPaymentErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_INVOICE'
  | 'INVOICE_EXPIRED'
  | 'NETWORK_MISMATCH'
  | 'INVALID_REQUEST'
  | 'AMOUNT_REQUIRED'
  | 'METHOD_UNSUPPORTED'
  | 'MAX_FEE_UNSUPPORTED'
  | 'NOT_CONNECTED'
  | 'PAYMENT_NOT_FOUND'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_AMBIGUOUS'
  | 'PROVIDER_UNAVAILABLE'
  | 'AUTHENTICATION_FAILED'
  | 'TIMEOUT'
  | 'CLOSED'
  | 'UNKNOWN'

export interface LightningPaymentErrorOptions {
  retryable?: boolean
  ambiguous?: boolean
  cause?: unknown
}

/** Stable transport-neutral error surfaced by Lightning payment services. */
export class LightningPaymentError extends Error {
  readonly code: LightningPaymentErrorCode
  readonly retryable: boolean
  readonly ambiguous: boolean
  readonly cause?: unknown

  constructor(
    code: LightningPaymentErrorCode,
    message: string,
    options: LightningPaymentErrorOptions = {},
  ) {
    super(message)
    this.name = 'LightningPaymentError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.ambiguous = options.ambiguous ?? code === 'PAYMENT_AMBIGUOUS'
    this.cause = options.cause
  }
}

export function isLightningPaymentError(error: unknown): error is LightningPaymentError {
  return error instanceof LightningPaymentError
}

/** Backwards-friendly shorter alias. */
export { LightningPaymentError as LightningError }
