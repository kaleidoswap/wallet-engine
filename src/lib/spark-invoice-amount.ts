import { ProtocolError } from '../types/base'

/** SDK-free shape of decoded Spark payment terms. */
interface SparkPaymentTerms {
  sparkInvoiceFields?: {
    paymentType?: { type: string; amount?: unknown }
  }
}

/** The BTC payment path cannot settle or report token invoices. */
export function sparkInvoiceAmount(decoded: SparkPaymentTerms, callerAmount?: number): number | undefined {
  const fields = decoded.sparkInvoiceFields
  if (!fields) return undefined
  if (fields.paymentType?.type !== 'sats') {
    throw new ProtocolError('A BTC payment requires a sats invoice', 'SPARK', 'UNSUPPORTED_INVOICE')
  }
  const amount = fields.paymentType.amount
  if (amount === undefined) return undefined
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new ProtocolError('Spark invoice amount must be a positive safe integer', 'SPARK', 'BAD_AMOUNT')
  }
  if (callerAmount != null && callerAmount !== amount) {
    throw new ProtocolError('Spark invoice amount differs from the requested amount', 'SPARK', 'AMOUNT_MISMATCH')
  }
  return amount
}
