import type {
  LightningInvoice,
  LightningPayment,
  LightningPaymentCapabilities,
  LightningPayments,
} from '@kaleidorg/wallet-engine/lightning'

const capabilities: LightningPaymentCapabilities = {
  createInvoice: true,
  payInvoice: true,
  lookupInvoice: true,
  lookupPayment: true,
  amountlessInvoices: true,
  maxFeeControl: true,
  idempotencyKeys: true,
  keysend: false,
}

// @ts-expect-error capability declarations must make an explicit keysend decision
const ambiguousCapabilities: LightningPaymentCapabilities = {
  createInvoice: true,
  payInvoice: true,
  lookupInvoice: true,
  lookupPayment: true,
  amountlessInvoices: true,
  maxFeeControl: true,
  idempotencyKeys: true,
}

const invoice: LightningInvoice = {
  bolt11: 'lnbc...',
  paymentHash: '00'.repeat(32),
  amountMsat: '9007199254740993',
  status: 'unpaid',
  createdAtUnixSeconds: 1_700_000_000,
  expiresAtUnixSeconds: 1_700_003_600,
}

const payment: LightningPayment = {
  paymentHash: invoice.paymentHash,
  amountMsat: invoice.amountMsat,
  feeMsat: '21',
  status: 'succeeded',
  settledAtUnixSeconds: 1_700_000_001,
}

declare const payments: LightningPayments
void payments.getNetwork()
void payments.getCapabilities()
void payments.createInvoice({ amountMsat: '1', requestId: 'invoice-1' })
void payments.payInvoice({
  bolt11: invoice.bolt11,
  maxFeeMsat: '1000',
  requestId: 'payment-1',
})
void payments.lookupInvoice({ paymentHash: invoice.paymentHash })
void payments.lookupPayment({ paymentHash: payment.paymentHash })
void payments.close()
void capabilities
void ambiguousCapabilities
