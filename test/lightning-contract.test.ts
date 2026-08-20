import { describe, expect, it } from 'vitest'

import {
  MAX_BITCOIN_SUPPLY_MSAT,
  MAX_BITCOIN_SUPPLY_SAT,
  msatToSat,
  parseMsat,
  parseSat,
  satToMsat,
  toSafeAmountNumber,
} from '../src/lightning/amounts'
import { LightningPaymentError, isLightningPaymentError } from '../src/lightning/errors'
import { defineLightningCapabilities } from '../src/lightning/types'

describe('Lightning decimal amounts', () => {
  it('parses canonical msat and sat strings without losing precision', () => {
    expect(parseMsat('9007199254740993')).toBe(9_007_199_254_740_993n)
    expect(parseSat('2100000000000000')).toBe(2_100_000_000_000_000n)
  })

  it.each(['', '-1', '+1', '1.0', '1e3', ' 1', '1 ', '00', '01'])(
    'rejects a non-canonical decimal amount: %j',
    (value) => {
      expect(() => parseMsat(value)).toThrow()
    },
  )

  it('rejects values beyond the Bitcoin monetary range', () => {
    expect(() => parseMsat((BigInt(MAX_BITCOIN_SUPPLY_MSAT) + 1n).toString())).toThrow()
    expect(() => parseSat((BigInt(MAX_BITCOIN_SUPPLY_SAT) + 1n).toString())).toThrow()
  })

  it('converts sat and msat strings exactly', () => {
    expect(satToMsat('2100000000000000')).toBe('2100000000000000000')
    expect(msatToSat('2100000000000000000')).toBe('2100000000000000')
    expect(() => msatToSat('1001')).toThrow(/whole satoshi/i)
  })

  it('only converts to number after an explicit safe-integer guard', () => {
    expect(toSafeAmountNumber('9007199254740991', 'msat')).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => toSafeAmountNumber('9007199254740992', 'msat')).toThrow(/safe integer/i)
  })
})

describe('transport-neutral Lightning payment contract', () => {
  it('requires an explicit boolean decision for every payment capability', () => {
    const capabilities = defineLightningCapabilities({
      createInvoice: true,
      payInvoice: true,
      lookupInvoice: true,
      lookupPayment: true,
      amountlessInvoices: true,
      maxFeeControl: false,
      idempotencyKeys: false,
      keysend: false,
    })

    expect(capabilities).toEqual({
      createInvoice: true,
      payInvoice: true,
      lookupInvoice: true,
      lookupPayment: true,
      amountlessInvoices: true,
      maxFeeControl: false,
      idempotencyKeys: false,
      keysend: false,
    })
    expect(() => defineLightningCapabilities({ payInvoice: true } as never)).toThrow(
      /capability.*createInvoice/i,
    )
  })

  it('surfaces stable typed error metadata without provider payloads', () => {
    const error = new LightningPaymentError(
      'PAYMENT_AMBIGUOUS',
      'Payment outcome must be reconciled by payment hash',
    )

    expect(isLightningPaymentError(error)).toBe(true)
    expect(error).toMatchObject({
      code: 'PAYMENT_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })
  })
})
