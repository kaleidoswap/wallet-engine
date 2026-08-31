/**
 * wallet-seed
 * -----------
 * Resolve a host wallet secret to the raw seed bytes the WDK wallet managers expect.
 *
 * The WDK base `WalletManager` validates a *string* secret with
 * `bip39.validateMnemonic`, but accepts a `Uint8Array` as raw seed bytes with NO
 * validation. Hosts here support wallets rooted on an `nsec1…` key or a raw hex
 * private key, not just BIP-39 phrases, so mirror the native adapters' resolution
 * and hand the managers bytes:
 *  - `nsec1…`      → the decoded 32-byte private key (HD master seed)
 *  - 64-hex-chars  → those 32 bytes (HD master seed)
 *  - otherwise     → a BIP-39 mnemonic → 64-byte PBKDF2 seed
 *
 * PARITY: the Spark path reproduces the native addresses for all three forms.
 * Arkade derives HD keys from the seed, so BIP-39 wallets match the native BIP-86
 * derivation but an nsec/hex-rooted Arkade wallet will not.
 */

import { bech32 } from '@scure/base'
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { hexToBytes } from '@noble/hashes/utils.js'

/** Decode an `nsec1…` bech32 secret into its 32 raw key bytes, or null. */
function nsecToBytes(input: string): Uint8Array | null {
  try {
    const decoded = bech32.decode(input as `${string}1${string}`, 1023)
    if (decoded.prefix !== 'nsec') return null
    const data = bech32.fromWords(decoded.words)
    // A Nostr secret key is exactly 32 bytes. A checksum-valid `nsec1…` encoding
    // any other length is malformed — reject it rather than seed the wallet with
    // wrong-length key material.
    if (data.length !== 32) return null
    return Uint8Array.from(data)
  } catch {
    return null
  }
}

/**
 * Resolve a wallet secret (nsec / hex private key / BIP-39 mnemonic) to the seed
 * bytes a WDK `WalletManager` consumes.
 *
 * Throws when the secret is none of the three forms, rather than silently deriving
 * a wrong wallet: `mnemonicToSeedSync` does NO validation — it PBKDF2s *any* string
 * — so a corrupted secret would resolve to a valid-but-different seed and a
 * different, empty HD wallet, surfacing as "my funds are gone" with no error.
 */
export function resolveWalletSeed(secret: string): Uint8Array {
  const trimmed = secret.trim()
  if (trimmed.startsWith('nsec1')) {
    const bytes = nsecToBytes(trimmed)
    if (!bytes) {
      throw new Error('Invalid wallet secret: nsec1… failed to decode to a 32-byte key')
    }
    return bytes
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed.toLowerCase())
  }
  // Otherwise it must be a BIP-39 mnemonic — validate its checksum/wordlist
  // before deriving, so an invalid phrase throws instead of seeding a wrong wallet.
  if (!validateMnemonic(trimmed, wordlist)) {
    throw new Error('Invalid wallet secret: not an nsec1… key, 64-char hex key, or valid BIP-39 mnemonic')
  }
  return mnemonicToSeedSync(trimmed)
}
