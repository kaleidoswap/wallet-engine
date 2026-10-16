import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bech32m } from '@scure/base'

/** Compressed pubkey for a small, deterministic secret scalar. */
export function testPubkey(seed = 1): Uint8Array {
  const secret = new Uint8Array(32)
  new DataView(secret.buffer).setUint32(28, seed)
  return secp256k1.getPublicKey(secret, true)
}

/**
 * Spark address the way spark-sdk's `encodeSparkAddress` builds it: bech32m over a
 * protobuf payload whose field 1 (tag 0x0a, length 33) is the identity pubkey.
 */
export function sparkAddress(hrp = 'spark', pubkey: Uint8Array = testPubkey()): string {
  const payload = Uint8Array.from([0x0a, 0x21, ...pubkey])
  return bech32m.encode(hrp, bech32m.toWords(payload), 1024)
}
