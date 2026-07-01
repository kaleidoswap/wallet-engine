import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { zbase32Encode, zbase32Decode } from "./zbase32";

// LND-style signMessage / verifyMessage.
//
//   prefix = "Lightning Signed Message:"
//   hash   = sha256(sha256(prefix + message))
//   sig    = recoverable ECDSA over secp256k1, 65 bytes (recid+31 || r || s)
//   text   = zbase32(sig)
//
// This is the format Alby's LND/lndhub/LNbits connectors return and is
// what LNURL-auth-style verifyMessage callers expect. The non-recoverable
// hex/DER form some other wallets emit cannot be verified without knowing
// the signing pubkey out-of-band.

const LN_MSG_PREFIX = new TextEncoder().encode("Lightning Signed Message:");

const LNURL_AUTH_CANONICAL_PHRASE =
  "DO NOT EVER SIGN THIS TEXT WITH YOUR PRIVATE KEYS! IT IS ONLY USED FOR DERIVATION OF LNURL-AUTH HASHING-KEY, DISCLOSING ITS SIGNATURE WILL COMPROMISE YOUR LNURL-AUTH IDENTITY AND MAY LEAD TO LOSS OF FUNDS!";

function lnMessageHash(message: string): Uint8Array {
  const msgBytes = new TextEncoder().encode(message);
  const concat = new Uint8Array(LN_MSG_PREFIX.length + msgBytes.length);
  concat.set(LN_MSG_PREFIX, 0);
  concat.set(msgBytes, LN_MSG_PREFIX.length);
  return sha256(sha256(concat));
}

/**
 * Reject phishing-style messages that match the canonical LNURL-auth
 * disclaimer. Signing one would expose the LNURL-auth identity.
 */
export function assertSafeToSign(message: string): void {
  if (message.trim() === LNURL_AUTH_CANONICAL_PHRASE.trim()) {
    throw new Error("Refusing to sign LNURL-auth canonical phrase");
  }
}

/**
 * Sign a message with the LND `signmessage` algorithm and return the
 * zbase32-encoded recoverable signature.
 */
export function signLnMessage(message: string, privateKey: Uint8Array): string {
  assertSafeToSign(message);
  const hash = lnMessageHash(message);
  // `format: "recovered"` returns 65 bytes laid out as [recid, r(32), s(32)].
  // `prehash: false` because we already hashed.
  const recovered = secp256k1.sign(hash, privateKey, {
    format: "recovered",
    prehash: false,
    lowS: true,
  });
  if (recovered.length !== 65) {
    throw new Error("Unexpected recoverable signature length");
  }
  // LND wire format adds 31 to the recovery id to land in the printable byte
  // range; downstream Bitcoin Core's signmessage uses 27 — we match LND.
  const out = new Uint8Array(65);
  out[0] = recovered[0] + 31;
  out.set(recovered.subarray(1), 1);
  return zbase32Encode(out);
}

/**
 * Verify a zbase32-encoded LND signature against the supplied message.
 * Returns the recovered compressed pubkey (hex) on success, or throws.
 */
export function verifyLnMessage(message: string, zbase32Signature: string): string {
  const bytes = zbase32Decode(zbase32Signature, 65);
  if (bytes.length !== 65) {
    throw new Error("Invalid signature length");
  }
  const recovery = bytes[0] - 31;
  if (recovery < 0 || recovery > 3) {
    throw new Error("Invalid recovery id");
  }
  // Reassemble `recovered` shape expected by @noble: [recid, r, s].
  const recoveredBytes = new Uint8Array(65);
  recoveredBytes[0] = recovery;
  recoveredBytes.set(bytes.subarray(1), 1);
  const hash = lnMessageHash(message);
  const pubkeyBytes = secp256k1.recoverPublicKey(recoveredBytes, hash, {
    prehash: false,
  });
  return bytesToHex(pubkeyBytes);
}

/**
 * Verify a zbase32 signature is from a specific pubkey. Throws on mismatch.
 */
export function verifyLnMessageFrom(
  message: string,
  zbase32Signature: string,
  expectedPubkeyHex: string,
): void {
  const recovered = verifyLnMessage(message, zbase32Signature);
  if (recovered.toLowerCase() !== expectedPubkeyHex.toLowerCase()) {
    throw new Error("Signature does not match expected pubkey");
  }
}
