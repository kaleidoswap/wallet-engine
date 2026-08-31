import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bech32 } from '@scure/base'

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const SIGNING_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1)

function uintWords(value: number, width?: number): number[] {
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

function sign(hrp: string, words: number[]): number[] {
  const prefix = new TextEncoder().encode(hrp)
  const data = wordsToPaddedBytes(words)
  const preimage = new Uint8Array(prefix.length + data.length)
  preimage.set(prefix)
  preimage.set(data, prefix.length)
  const recovered = secp256k1.sign(sha256(preimage), SIGNING_KEY, {
    prehash: false,
    format: 'recovered',
  })
  return bech32.toWords(Uint8Array.from([...recovered.slice(1), recovered[0]]))
}

export const TEST_PREIMAGE = 'cd'.repeat(32)
const TEST_PAYMENT_HASH_BYTES = sha256(
  Uint8Array.from(TEST_PREIMAGE.match(/../g)!.map((byte) => Number.parseInt(byte, 16))),
)
export const TEST_PAYMENT_HASH = Array.from(
  TEST_PAYMENT_HASH_BYTES,
  (byte) => byte.toString(16).padStart(2, '0'),
).join('')

export function bolt11Fixture(options: {
  hrp?: string
  timestamp?: number
  expirySeconds?: number
} = {}): string {
  const hrp = options.hrp ?? 'lnbc10p'
  const timestamp = options.timestamp ?? 1_700_000_000
  const fields = [
    ...taggedField('s', bech32.toWords(new Uint8Array(32).fill(1))),
    ...taggedField('p', bech32.toWords(TEST_PAYMENT_HASH_BYTES)),
    ...taggedField('d', bech32.toWords(new TextEncoder().encode('test invoice'))),
    ...taggedField('x', uintWords(options.expirySeconds ?? 3600)),
  ]
  const data = [...uintWords(timestamp, 7), ...fields]
  return bech32.encode(hrp, [...data, ...sign(hrp, data)], false)
}
