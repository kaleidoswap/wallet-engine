/**
 * Address -> scriptPubKey
 * -----------------------
 * Derives the output script a swap lockup address commits to, so a transaction
 * fetched from a trusted chain source can be matched against the maker's claimed
 * lockup by SCRIPT rather than by the address string the explorer happens to
 * print. Liquid explorers report the unconfidential form of a confidential
 * address, so a string compare would never match a Boltz `el1qq…`/`lq1qq…` lockup.
 *
 * Covers the segwit forms a Boltz chain swap can produce: bech32 (v0) and bech32m
 * (v1+) on Bitcoin and unconfidential Liquid, blech32/blech32m confidential Liquid.
 * Legacy base58 is rejected rather than guessed — a lockup there is a protocol
 * change this guard must not paper over.
 */

import { bech32, bech32m } from '@scure/base'
import { bytesToHex } from '@noble/hashes/utils.js'

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

/** HRPs of bech32/bech32m addresses: Bitcoin plus unconfidential Liquid. */
const BECH32_HRPS = new Set(['bc', 'tb', 'bcrt', 'ex', 'tex', 'ert'])
/** HRPs of blech32/blech32m confidential Liquid addresses. */
const BLECH32_HRPS = new Set(['lq', 'tlq', 'el'])

/** Blech32 generator (Elements `blech32.cpp`); a 64-bit checksum, hence BigInt. */
const BLECH32_GENERATOR = [
  0x7d52fba40bd886n,
  0x5e8dbf1a03950cn,
  0x1c3a3c74072a18n,
  0x385d72fa0e5139n,
  0x7093e5a608865bn,
]
const BLECH32_CONST = 1n
const BLECH32M_CONST = 0x455972a3350f7a1n
const BLECH32_CHECKSUM_LEN = 12
const BLINDING_KEY_LEN = 33

function blech32Polymod(values: number[]): bigint {
  let c = 1n
  for (const v of values) {
    const c0 = c >> 55n
    c = ((c & 0x7fffffffffffffn) << 5n) ^ BigInt(v)
    for (let i = 0; i < 5; i++) {
      if ((c0 >> BigInt(i)) & 1n) c ^= BLECH32_GENERATOR[i]
    }
  }
  return c
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (const ch of hrp) out.push(ch.charCodeAt(0) >> 5)
  out.push(0)
  for (const ch of hrp) out.push(ch.charCodeAt(0) & 31)
  return out
}

/** 5-bit groups -> bytes, rejecting padding that is not zero or too long. */
function fromWords(words: number[]): Uint8Array {
  let acc = 0
  let bits = 0
  const out: number[] = []
  for (const w of words) {
    acc = (acc << 5) | w
    bits += 5
    while (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  if (bits >= 5 || (acc << (8 - bits)) & 0xff) {
    throw new Error('Invalid blech32 padding')
  }
  return Uint8Array.from(out)
}

interface SegwitProgram {
  version: number
  program: Uint8Array
}

function decodeBlech32(address: string): SegwitProgram {
  const lower = address.toLowerCase()
  if (lower !== address && address.toUpperCase() !== address) {
    throw new Error('Mixed-case blech32 address')
  }
  const sep = lower.lastIndexOf('1')
  if (sep < 1) throw new Error('Malformed blech32 address')
  const hrp = lower.slice(0, sep)
  const data = lower.slice(sep + 1)
  if (data.length < BLECH32_CHECKSUM_LEN + 1) throw new Error('Malformed blech32 address')
  const words: number[] = []
  for (const ch of data) {
    const w = BECH32_CHARSET.indexOf(ch)
    if (w < 0) throw new Error('Invalid blech32 character')
    words.push(w)
  }
  const residue = blech32Polymod([...hrpExpand(hrp), ...words])
  const version = words[0]
  const expected = version === 0 ? BLECH32_CONST : BLECH32M_CONST
  if (residue !== expected) throw new Error('Invalid blech32 checksum')
  const payload = fromWords(words.slice(1, words.length - BLECH32_CHECKSUM_LEN))
  if (payload.length <= BLINDING_KEY_LEN) throw new Error('Blech32 payload too short')
  return { version, program: payload.slice(BLINDING_KEY_LEN) }
}

function decodeBech32(address: string): SegwitProgram {
  const lower = address.toLowerCase()
  const sep = lower.lastIndexOf('1')
  if (sep < 1) throw new Error('Malformed bech32 address')
  const data = lower.slice(sep + 1)
  const version = BECH32_CHARSET.indexOf(data[0] ?? '')
  if (version < 0) throw new Error('Invalid bech32 character')
  // v0 is bech32, v1+ is bech32m (BIP-350); the wrong codec fails its checksum.
  const codec = version === 0 ? bech32 : bech32m
  const decoded = codec.decode(address as `${string}1${string}`, 120)
  return { version, program: codec.fromWords(decoded.words.slice(1)) }
}

function segwitScript({ version, program }: SegwitProgram): string {
  if (version > 16) throw new Error(`Invalid witness version ${version}`)
  if (program.length < 2 || program.length > 40) {
    throw new Error(`Invalid witness program length ${program.length}`)
  }
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    throw new Error(`Invalid v0 witness program length ${program.length}`)
  }
  const opcode = version === 0 ? 0 : 0x50 + version
  return bytesToHex(Uint8Array.from([opcode, program.length, ...program]))
}

/**
 * The hex scriptPubKey an address pays to. Throws on anything that is not a
 * segwit address on Bitcoin or Liquid (confidential or not).
 */
export function scriptPubKeyFromAddress(address: string): string {
  const lower = address.toLowerCase()
  const sep = lower.lastIndexOf('1')
  const hrp = sep > 0 ? lower.slice(0, sep) : ''
  if (BLECH32_HRPS.has(hrp)) return segwitScript(decodeBlech32(address))
  if (BECH32_HRPS.has(hrp)) return segwitScript(decodeBech32(address))
  throw new Error(`Unsupported lockup address format: ${address.slice(0, 8)}…`)
}
