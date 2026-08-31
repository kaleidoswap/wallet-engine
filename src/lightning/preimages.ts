import { sha256 } from '@noble/hashes/sha2.js'

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)))
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function isLightningPreimage(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

export function paymentHashFromPreimage(preimage: string): string {
  return bytesToHex(sha256(hexToBytes(preimage)))
}

export function preimageMatchesPaymentHash(value: unknown, paymentHash: string): value is string {
  return isLightningPreimage(value) && paymentHashFromPreimage(value) === paymentHash.toLowerCase()
}
