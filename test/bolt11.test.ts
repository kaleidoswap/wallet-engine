import { describe, it, expect } from 'vitest'
import { bech32 } from '@scure/base'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'

import {
  decodeBolt11,
  decodeBolt11Invoice,
  isBolt11,
  isValidBolt11,
  validateBolt11Invoice,
} from '../src/lib/bolt11'

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const PAYMENT_HASH = Uint8Array.from({ length: 32 }, (_, index) => index)
const PAYMENT_HASH_HEX = Array.from(PAYMENT_HASH, (byte) => byte.toString(16).padStart(2, '0')).join('')
const SIGNING_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const OFFICIAL_BOLT11 =
  'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql'

function uintWords(value: number | bigint, width?: number): number[] {
  let remaining = BigInt(value)
  const words: number[] = []
  do {
    words.unshift(Number(remaining & 31n))
    remaining >>= 5n
  } while (remaining > 0n)
  while (width != null && words.length < width) words.unshift(0)
  return words
}

function taggedField(tag: string, words: number[]): number[] {
  const tagValue = BECH32_CHARSET.indexOf(tag)
  if (tagValue < 0 || words.length > 1023) throw new Error('invalid test tag')
  return [tagValue, words.length >> 5, words.length & 31, ...words]
}

function wordsToPaddedBytes(words: number[]): Uint8Array {
  const bytes: number[] = []
  let accumulator = 0
  let bitCount = 0
  for (const word of words) {
    accumulator = (accumulator << 5) | word
    bitCount += 5
    while (bitCount >= 8) {
      bitCount -= 8
      bytes.push((accumulator >> bitCount) & 0xff)
    }
  }
  if (bitCount > 0) bytes.push((accumulator << (8 - bitCount)) & 0xff)
  return Uint8Array.from(bytes)
}

function signBolt11(hrp: string, words: number[]): number[] {
  const prefix = new TextEncoder().encode(hrp)
  const data = wordsToPaddedBytes(words)
  const preimage = new Uint8Array(prefix.length + data.length)
  preimage.set(prefix)
  preimage.set(data, prefix.length)
  const recovered = secp256k1.sign(sha256(preimage), SIGNING_KEY, {
    prehash: false,
    format: 'recovered',
  })
  const boltSignature = Uint8Array.from([...recovered.slice(1), recovered[0]])
  return bech32.toWords(boltSignature)
}

function bolt11Fixture(options: {
  hrp?: string
  timestamp?: number
  expirySeconds?: number
  includePaymentHash?: boolean
  paymentHashWords?: number[]
  includePaymentSecret?: boolean
  includeDescription?: boolean
  invalidSignature?: boolean
  extraFields?: number[][]
} = {}): string {
  const {
    hrp = 'lnbc10p',
    timestamp = 1_700_000_000,
    expirySeconds = 3600,
    includePaymentHash = true,
    paymentHashWords = bech32.toWords(PAYMENT_HASH),
    includePaymentSecret = true,
    includeDescription = true,
    invalidSignature = false,
    extraFields = [],
  } = options
  const fields = [
    ...(includePaymentSecret ? taggedField('s', bech32.toWords(new Uint8Array(32).fill(1))) : []),
    ...(includePaymentHash ? taggedField('p', paymentHashWords) : []),
    ...(includeDescription
      ? taggedField('d', bech32.toWords(new TextEncoder().encode('test invoice')))
      : []),
    ...taggedField('x', uintWords(expirySeconds)),
    ...extraFields.flat(),
  ]
  const data = [...uintWords(timestamp, 7), ...fields]
  const signature = invalidSignature ? bech32.toWords(new Uint8Array(65)) : signBolt11(hrp, data)
  return bech32.encode(hrp, [...data, ...signature], false)
}

function expectErrorCode(run: () => unknown, code: string): void {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toMatchObject({ code })
}

describe('decodeBolt11', () => {
  it('returns network with no amount for an amountless invoice', () => {
    const r = decodeBolt11('lnbc1pexampleamountless')
    expect(r.network).toBe('bc')
    expect(r.amountSat).toBeUndefined()
  })

  it('decodes the milli/micro/nano/pico multipliers', () => {
    // 1m BTC = 0.001 BTC = 100_000 sat
    expect(decodeBolt11('lnbc1m1pexample').amountSat).toBe(100_000)
    // 2500u BTC = 0.0025 BTC = 250_000 sat
    expect(decodeBolt11('lnbc2500u1pexample').amountSat).toBe(250_000)
    // 1500n BTC = 0.0000015 BTC = 150 sat
    expect(decodeBolt11('lnbc1500n1pexample').amountSat).toBe(150)
    // 1000000p BTC = 0.00000001 BTC * ... → rounds to 100 sat
    expect(decodeBolt11('lnbc1000000p1pexample').amountSat).toBe(100)
  })

  it('exposes msat as the source-of-truth amount (sub-sat precision preserved)', () => {
    // 1500n BTC = 150 sat = 150_000 msat
    expect(decodeBolt11('lnbc1500n1pexample').amountMsat).toBe(150_000)
    // 10p BTC = 1 msat — rounds to 0 sat for display but msat keeps the value.
    const r = decodeBolt11('lnbc10p1pexample')
    expect(r.amountMsat).toBe(1)
    expect(r.amountSat).toBe(0)
  })

  it('treats a bare digit amount with no multiplier as whole BTC', () => {
    // lnbc1<sep>... is amountless (the 1 is the bech32 separator), so use 2.
    expect(decodeBolt11('lnbc21pexample').amountSat).toBe(2 * 1e8)
  })

  it('detects testnet / signet / regtest networks', () => {
    expect(decodeBolt11('lntb1pexample').network).toBe('tb')
    expect(decodeBolt11('lntbs1pexample').network).toBe('tbs')
    expect(decodeBolt11('lnbcrt1pexample').network).toBe('bcrt')
  })

  it('returns network "unknown" for a non-BOLT11 string', () => {
    expect(decodeBolt11('bc1qexample').network).toBe('unknown')
    expect(decodeBolt11('').network).toBe('unknown')
  })
})

describe('isBolt11', () => {
  it('is true for LN invoices across networks, false otherwise', () => {
    expect(isBolt11('lnbc1pxyz')).toBe(true)
    expect(isBolt11('LNTB1PXYZ')).toBe(true)
    expect(isBolt11('  lnbcrt1pxyz  ')).toBe(true)
    expect(isBolt11('bc1qxyz')).toBe(false)
    expect(isBolt11('')).toBe(false)
  })
})

describe('strict BOLT11 validation', () => {
  it('extracts an exact amount, payment hash, timestamps, and invoice HRP identity', () => {
    const decoded = decodeBolt11Invoice(bolt11Fixture())

    expect(decoded).toEqual({
      amountMsat: '1',
      paymentHash: PAYMENT_HASH_HEX,
      createdAtUnixSeconds: 1_700_000_000,
      expiresAtUnixSeconds: 1_700_003_600,
      network: {
        chain: 'bitcoin',
        hrp: 'bc',
        networkId: 'bitcoin',
        evidence: 'invoice-hrp',
      },
    })
  })

  it('keeps amountless invoices amountless and defaults expiry to one hour', () => {
    const fields = [
      ...taggedField('s', bech32.toWords(new Uint8Array(32).fill(1))),
      ...taggedField('p', bech32.toWords(PAYMENT_HASH)),
      ...taggedField('d', bech32.toWords(new TextEncoder().encode('test invoice'))),
    ]
    const data = [...uintWords(1_700_000_000, 7), ...fields]
    const amountless = bech32.encode(
      'lntb',
      [...data, ...signBolt11('lntb', data)],
      false,
    )

    const decoded = decodeBolt11Invoice(amountless)
    expect(decoded.amountMsat).toBeUndefined()
    expect(decoded).toMatchObject({
      createdAtUnixSeconds: 1_700_000_000,
      expiresAtUnixSeconds: 1_700_003_600,
      network: { hrp: 'tb', networkId: 'testnet-or-signet' },
    })
  })

  it('enforces expiry and an allowlisted HRP before payment', () => {
    const invoice = bolt11Fixture({ hrp: 'lntb10p', timestamp: 1000, expirySeconds: 60 })

    expectErrorCode(
      () => validateBolt11Invoice(invoice, { allowedHrps: ['bc'], nowUnixSeconds: 1050 }),
      'NETWORK_MISMATCH',
    )
    expectErrorCode(
      () => validateBolt11Invoice(invoice, { allowedHrps: ['tb'], nowUnixSeconds: 1060 }),
      'INVOICE_EXPIRED',
    )
    expect(validateBolt11Invoice(invoice, { allowedHrps: ['tb'], nowUnixSeconds: 1059 })).toMatchObject({
      paymentHash: PAYMENT_HASH_HEX,
    })
  })

  it('rejects checksum failures, missing or malformed payment hashes, and duplicate identity fields', () => {
    const valid = bolt11Fixture()
    const badChecksum = `${valid.slice(0, -1)}${valid.endsWith('q') ? 'p' : 'q'}`
    const duplicatePaymentHash = bolt11Fixture({
      extraFields: [taggedField('p', bech32.toWords(PAYMENT_HASH))],
    })

    expectErrorCode(() => decodeBolt11Invoice(badChecksum), 'INVALID_INVOICE')
    expectErrorCode(
      () => decodeBolt11Invoice(bolt11Fixture({ includePaymentHash: false })),
      'INVALID_INVOICE',
    )
    expectErrorCode(
      () => decodeBolt11Invoice(bolt11Fixture({ paymentHashWords: [0] })),
      'INVALID_INVOICE',
    )
    expectErrorCode(() => decodeBolt11Invoice(duplicatePaymentHash), 'INVALID_INVOICE')
    expect(isValidBolt11(valid)).toBe(true)
    expect(isValidBolt11(badChecksum)).toBe(false)
  })

  it('verifies the signature and mandatory payment identity fields', () => {
    expectErrorCode(() => decodeBolt11Invoice(bolt11Fixture({ invalidSignature: true })), 'INVALID_INVOICE')
    expectErrorCode(
      () => decodeBolt11Invoice(bolt11Fixture({ includePaymentSecret: false })),
      'INVALID_INVOICE',
    )
    expectErrorCode(
      () => decodeBolt11Invoice(bolt11Fixture({ includeDescription: false })),
      'INVALID_INVOICE',
    )
  })

  it('decodes and verifies the official BOLT11 reference vector', () => {
    expect(decodeBolt11Invoice(OFFICIAL_BOLT11)).toMatchObject({
      paymentHash: '0001020304050607080900010203040506070809000102030405060708090102',
      createdAtUnixSeconds: 1_496_314_658,
      expiresAtUnixSeconds: 1_496_318_258,
      network: { hrp: 'bc', networkId: 'bitcoin' },
    })
  })

  it('rejects non-integral pico-BTC amounts instead of rounding them', () => {
    expectErrorCode(() => decodeBolt11Invoice(bolt11Fixture({ hrp: 'lnbc1p' })), 'INVALID_AMOUNT')
  })
})
