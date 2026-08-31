import { bech32 } from '@scure/base'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { parseMsat } from '../lightning/amounts'
import { LightningPaymentError } from '../lightning/errors'

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const DEFAULT_EXPIRY_SECONDS = 3600n
const SIGNATURE_WORDS = 104
const TIMESTAMP_WORDS = 7
const MAX_BOLT11_LENGTH = 20_000
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)

export type Bolt11Hrp = 'bc' | 'tb' | 'tbs' | 'bcrt' | 'sb'
export type Bolt11NetworkId = 'bitcoin' | 'testnet-or-signet' | 'signet' | 'regtest' | 'simnet'

export interface Bolt11NetworkIdentity {
  chain: 'bitcoin'
  hrp: Bolt11Hrp
  networkId: Bolt11NetworkId
  evidence: 'invoice-hrp'
}

export interface DecodedBolt11Invoice {
  /** Exact millisatoshi amount. Missing for an amountless invoice. */
  amountMsat?: string
  /** Exact whole-satoshi amount. Missing when the amount has sub-satoshi precision. */
  amountSat?: string
  paymentHash: string
  createdAtUnixSeconds: number
  expiresAtUnixSeconds: number
  network: Bolt11NetworkIdentity
}

export interface Bolt11ValidationPolicy {
  /** HRPs accepted by the caller. Prefer this when testnet/signet ambiguity matters. */
  allowedHrps?: readonly Bolt11Hrp[]
  /** Convenience network policy. `signet` accepts both shared `tb` and legacy `tbs`. */
  expectedNetworkId?: 'bitcoin' | 'testnet' | 'signet' | 'regtest' | 'simnet'
  /** Deterministic clock seam. Defaults to the current Unix time. */
  nowUnixSeconds?: number
  /** Decode historical invoices without rejecting their expiry. Defaults to false. */
  allowExpired?: boolean
}

/**
 * Compatibility summary used by existing adapters. Exact string fields are
 * authoritative; legacy number fields are populated only when conversion is safe,
 * and `amountSat` stays a rounded display-only value.
 */
export interface Bolt11Summary {
  amountMsatString?: string
  amountSatString?: string
  amountMsat?: number
  amountSat?: number
  /** Network token from the HRP: bc | tb | tbs | bcrt | sb. */
  network: string
}

function invalidInvoice(message: string, _cause?: unknown): LightningPaymentError {
  // Decoder errors may quote the complete BOLT11 (including its payment
  // secret). Keep only the stable, sanitized contract message.
  return new LightningPaymentError('INVALID_INVOICE', message)
}

function wordsToBigInt(words: readonly number[]): bigint {
  let value = 0n
  for (const word of words) value = (value << 5n) | BigInt(word)
  return value
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function wordsToPaddedBytes(words: readonly number[]): Uint8Array {
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

function decodeFixedBytes(words: number[], byteLength: number, field: string): Uint8Array {
  try {
    const bytes = bech32.fromWords(words)
    if (bytes.length !== byteLength) throw invalidInvoice(`BOLT11 ${field} has an invalid length`)
    return bytes
  } catch (error) {
    if (error instanceof LightningPaymentError) throw error
    throw invalidInvoice(`BOLT11 ${field} has invalid bit padding`, error)
  }
}

function parseHrpAmount(digits: string | undefined, multiplier: string | undefined): string | undefined {
  if (digits == null) return undefined
  if (!/^(0|[1-9]\d*)$/.test(digits) || digits === '0') {
    throw new LightningPaymentError('INVALID_AMOUNT', 'BOLT11 amount is not canonical and positive')
  }

  const value = BigInt(digits)
  let amountMsat: bigint
  switch (multiplier ?? '') {
    case '':
      amountMsat = value * 100_000_000_000n
      break
    case 'm':
      amountMsat = value * 100_000_000n
      break
    case 'u':
      amountMsat = value * 100_000n
      break
    case 'n':
      amountMsat = value * 100n
      break
    case 'p':
      if (value % 10n !== 0n) {
        throw new LightningPaymentError(
          'INVALID_AMOUNT',
          'BOLT11 pico-BTC amount does not represent a whole millisatoshi',
        )
      }
      amountMsat = value / 10n
      break
    default:
      throw new LightningPaymentError('INVALID_AMOUNT', 'BOLT11 amount multiplier is invalid')
  }

  try {
    return parseMsat(amountMsat.toString()).toString()
  } catch (error) {
    throw new LightningPaymentError('INVALID_AMOUNT', 'BOLT11 amount is outside the monetary range', {
      cause: error,
    })
  }
}

function parseHrp(prefix: string): {
  amountMsat?: string
  hrp: Bolt11Hrp
  network: Bolt11NetworkIdentity
} {
  const match = prefix.toLowerCase().match(/^ln(bcrt|tbs|bc|tb|sb)(?:(\d+)([munp]?))?$/)
  if (!match) throw invalidInvoice('BOLT11 human-readable prefix is invalid')

  const hrp = match[1] as Bolt11Hrp
  const networkIds: Record<Bolt11Hrp, Bolt11NetworkId> = {
    bc: 'bitcoin',
    tb: 'testnet-or-signet',
    tbs: 'signet',
    bcrt: 'regtest',
    sb: 'simnet',
  }
  return {
    amountMsat: parseHrpAmount(match[2], match[3]),
    hrp,
    network: {
      chain: 'bitcoin',
      hrp,
      networkId: networkIds[hrp],
      evidence: 'invoice-hrp',
    },
  }
}

/**
 * Even feature bits this payer is prepared to honour.
 *
 * BOLT 9 splits the feature vector by parity: an odd bit is optional, an even bit
 * is mandatory and a payer that does not understand it MUST NOT pay. These are the
 * ubiquitous modern requirements; `payment_secret` (14) is already enforced
 * structurally, since a missing `s` field is rejected outright.
 *
 * Everything else is refused rather than delegated: these adapters do not route,
 * they hand the invoice to a provider, so paying an invoice whose mandatory
 * requirement we cannot name means discovering the mismatch as an opaque provider
 * failure after the money is in flight. Extend deliberately, per bit.
 */
const SUPPORTED_EVEN_FEATURE_BITS: ReadonlySet<number> = new Set([
  8, // var_onion_optin
  14, // payment_secret
  16, // basic_mpp
])

/**
 * Reject an invoice mandating a feature this payer cannot claim to support. The
 * field is a big-endian bitvector packed into 5-bit words, so bit 0 is the low bit
 * of the final word and numbering runs backwards from the end.
 */
function assertSupportedFeatures(words: readonly number[]): void {
  const totalBits = words.length * 5
  for (let index = 0; index < words.length; index += 1) {
    for (let bit = 0; bit < 5; bit += 1) {
      if ((words[index] & (1 << (4 - bit))) === 0) continue
      const position = totalBits - 1 - (index * 5 + bit)
      if (position % 2 !== 0) continue
      if (!SUPPORTED_EVEN_FEATURE_BITS.has(position)) {
        throw invalidInvoice(`BOLT11 requires unsupported mandatory feature bit ${position}`)
      }
    }
  }
}

function decodePaymentHash(words: number[]): string {
  if (words.length !== 52) throw invalidInvoice('BOLT11 payment hash must contain 32 bytes')
  return bytesToHex(decodeFixedBytes(words, 32, 'payment hash'))
}

function verifySignature(
  prefix: string,
  dataWords: number[],
  signature: Uint8Array,
  payeePubkey?: Uint8Array,
): void {
  const prefixBytes = new TextEncoder().encode(prefix.toLowerCase())
  const dataBytes = wordsToPaddedBytes(dataWords)
  const preimage = new Uint8Array(prefixBytes.length + dataBytes.length)
  preimage.set(prefixBytes)
  preimage.set(dataBytes, prefixBytes.length)
  const digest = sha256(preimage)
  const compact = signature.slice(0, 64)
  const recovered = Uint8Array.from([signature[64], ...compact])

  try {
    if (payeePubkey != null) {
      if (!secp256k1.verify(compact, digest, payeePubkey, { prehash: false, lowS: true })) {
        throw invalidInvoice('BOLT11 signature does not match the payee public key')
      }
    } else {
      // Recovery validates r/s and the recovery id. BOLT11 permits high-S
      // signatures when no explicit `n` payee field is present.
      secp256k1.recoverPublicKey(recovered, digest, { prehash: false })
    }
  } catch (error) {
    if (error instanceof LightningPaymentError) throw error
    throw invalidInvoice('BOLT11 signature is invalid', error)
  }
}

/** Decode checksum-verified BOLT11 payment identity and expiry fields. */
export function decodeBolt11Invoice(invoice: string): DecodedBolt11Invoice {
  if (typeof invoice !== 'string' || invoice.length === 0 || invoice.length > MAX_BOLT11_LENGTH) {
    throw invalidInvoice('BOLT11 invoice length is invalid')
  }

  let decoded: { prefix: string; words: number[] }
  try {
    decoded = bech32.decode(invoice, false)
  } catch (error) {
    throw invalidInvoice('BOLT11 checksum or encoding is invalid', error)
  }

  const { amountMsat, network } = parseHrp(decoded.prefix)
  const words = decoded.words
  if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) {
    throw invalidInvoice('BOLT11 payload is truncated')
  }

  const signatureWords = words.slice(-SIGNATURE_WORDS)
  let signature: Uint8Array
  try {
    signature = bech32.fromWords(signatureWords)
    if (signature.length !== 65 || signature[64] > 3) {
      throw invalidInvoice('BOLT11 signature field is malformed')
    }
  } catch (error) {
    if (error instanceof LightningPaymentError) throw error
    throw invalidInvoice('BOLT11 signature field is malformed', error)
  }

  const createdAt = wordsToBigInt(words.slice(0, TIMESTAMP_WORDS))
  const taggedWords = words.slice(TIMESTAMP_WORDS, -SIGNATURE_WORDS)
  let paymentHash: string | undefined
  let expirySeconds = DEFAULT_EXPIRY_SECONDS
  let hasExpiry = false
  let hasPaymentSecret = false
  let hasDescription = false
  let hasDescriptionHash = false
  let hasFeatures = false
  let payeePubkey: Uint8Array | undefined

  for (let offset = 0; offset < taggedWords.length; ) {
    if (taggedWords.length - offset < 3) throw invalidInvoice('BOLT11 tagged field header is truncated')
    const tag = BECH32_CHARSET[taggedWords[offset]]
    const length = (taggedWords[offset + 1] << 5) | taggedWords[offset + 2]
    offset += 3
    if (offset + length > taggedWords.length) throw invalidInvoice('BOLT11 tagged field is truncated')
    const data = taggedWords.slice(offset, offset + length)
    offset += length

    if (tag === 'p') {
      if (paymentHash != null) throw invalidInvoice('BOLT11 payment hash field is duplicated')
      paymentHash = decodePaymentHash(data)
    } else if (tag === 's') {
      if (hasPaymentSecret || data.length !== 52) {
        throw invalidInvoice('BOLT11 payment secret field is invalid or duplicated')
      }
      decodeFixedBytes(data, 32, 'payment secret')
      hasPaymentSecret = true
    } else if (tag === 'd') {
      if (hasDescription || hasDescriptionHash) {
        throw invalidInvoice('BOLT11 must contain exactly one description or description hash')
      }
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bech32.fromWords(data))
      } catch (error) {
        throw invalidInvoice('BOLT11 description is not valid UTF-8', error)
      }
      hasDescription = true
    } else if (tag === 'h') {
      if (hasDescription || hasDescriptionHash || data.length !== 52) {
        throw invalidInvoice('BOLT11 description hash field is invalid or duplicated')
      }
      decodeFixedBytes(data, 32, 'description hash')
      hasDescriptionHash = true
    } else if (tag === 'n') {
      if (payeePubkey != null || data.length !== 53) {
        throw invalidInvoice('BOLT11 payee public key field is invalid or duplicated')
      }
      payeePubkey = decodeFixedBytes(data, 33, 'payee public key')
      if (!secp256k1.utils.isValidPublicKey(payeePubkey, true)) {
        throw invalidInvoice('BOLT11 payee public key is invalid')
      }
    } else if (tag === '9') {
      if (hasFeatures) throw invalidInvoice('BOLT11 features field is duplicated')
      hasFeatures = true
      assertSupportedFeatures(data)
    } else if (tag === 'x') {
      if (hasExpiry || data.length === 0 || (data.length > 1 && data[0] === 0)) {
        throw invalidInvoice('BOLT11 expiry field is invalid, non-minimal, or duplicated')
      }
      hasExpiry = true
      expirySeconds = wordsToBigInt(data)
    }
  }

  if (paymentHash == null) throw invalidInvoice('BOLT11 payment hash field is required')
  if (!hasPaymentSecret) throw invalidInvoice('BOLT11 payment secret field is required')
  if (!hasDescription && !hasDescriptionHash) {
    throw invalidInvoice('BOLT11 description or description hash field is required')
  }
  verifySignature(decoded.prefix, words.slice(0, -SIGNATURE_WORDS), signature, payeePubkey)
  const expiresAt = createdAt + expirySeconds
  if (createdAt > MAX_SAFE_INTEGER || expirySeconds > MAX_SAFE_INTEGER || expiresAt > MAX_SAFE_INTEGER) {
    throw invalidInvoice('BOLT11 timestamp or expiry exceeds the safe integer range')
  }

  const amountSat = amountMsat != null && BigInt(amountMsat) % 1000n === 0n
    ? (BigInt(amountMsat) / 1000n).toString()
    : undefined

  return {
    ...(amountMsat != null ? { amountMsat } : {}),
    ...(amountSat != null ? { amountSat } : {}),
    paymentHash,
    createdAtUnixSeconds: Number(createdAt),
    expiresAtUnixSeconds: Number(expiresAt),
    network,
  }
}

function hrpsForNetwork(networkId: NonNullable<Bolt11ValidationPolicy['expectedNetworkId']>): readonly Bolt11Hrp[] {
  switch (networkId) {
    case 'bitcoin': return ['bc']
    case 'testnet': return ['tb']
    case 'signet': return ['tb', 'tbs']
    case 'regtest': return ['bcrt']
    case 'simnet': return ['sb']
  }
}

/** Decode a BOLT11 invoice and enforce caller-selected network and expiry policy. */
export function validateBolt11Invoice(
  invoice: string,
  policy: Bolt11ValidationPolicy = {},
): DecodedBolt11Invoice {
  const decoded = decodeBolt11Invoice(invoice)
  const allowedHrps = policy.allowedHrps
  if (allowedHrps != null && !allowedHrps.includes(decoded.network.hrp)) {
    throw new LightningPaymentError('NETWORK_MISMATCH', 'BOLT11 invoice HRP is not allowed')
  }
  if (
    policy.expectedNetworkId != null &&
    !hrpsForNetwork(policy.expectedNetworkId).includes(decoded.network.hrp)
  ) {
    throw new LightningPaymentError('NETWORK_MISMATCH', 'BOLT11 invoice network does not match')
  }

  const now = policy.nowUnixSeconds ?? Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new LightningPaymentError('INVALID_REQUEST', 'nowUnixSeconds must be a non-negative safe integer')
  }
  if (!policy.allowExpired && now >= decoded.expiresAtUnixSeconds) {
    throw new LightningPaymentError('INVOICE_EXPIRED', 'BOLT11 invoice has expired')
  }
  return decoded
}

/** True only for a checksum-valid, structurally valid BOLT11 invoice. */
export function isValidBolt11(invoice: string, policy?: Bolt11ValidationPolicy): boolean {
  try {
    if (policy == null) decodeBolt11Invoice(invoice)
    else validateBolt11Invoice(invoice, policy)
    return true
  } catch {
    return false
  }
}

/**
 * Parse a BOLT11 HRP for compatibility with existing display helpers. Use
 * `decodeBolt11Invoice`/`validateBolt11Invoice` before authorizing payment.
 */
export function decodeBolt11(invoice: string): Bolt11Summary {
  const value = (invoice ?? '').trim().toLowerCase()
  const match = value.match(/^ln(bcrt|tbs|bc|tb|sb)(?:(\d+)([munp]?))?1/)
  if (!match) return { network: 'unknown' }

  let amountMsatString: string | undefined
  try {
    amountMsatString = parseHrpAmount(match[2], match[3])
  } catch {
    return { network: match[1] }
  }
  if (amountMsatString == null) return { network: match[1] }

  const amountMsatBigInt = BigInt(amountMsatString)
  const roundedSat = (amountMsatBigInt + 500n) / 1000n
  return {
    amountMsatString,
    ...(amountMsatBigInt % 1000n === 0n
      ? { amountSatString: (amountMsatBigInt / 1000n).toString() }
      : {}),
    ...(amountMsatBigInt <= MAX_SAFE_INTEGER ? { amountMsat: Number(amountMsatBigInt) } : {}),
    amountSat: Number(roundedSat),
    network: match[1],
  }
}

/** Prefix-level compatibility check. This does not verify the checksum. */
export function isBolt11(value: string): boolean {
  return /^ln(bcrt|tbs|bc|tb|sb)[0-9]/i.test((value ?? '').trim())
}
