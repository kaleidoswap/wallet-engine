/**
 * wallet-seed
 * -----------
 * Resolve an extension/host wallet secret to the raw seed bytes the WDK wallet
 * managers expect.
 *
 * The WDK base `WalletManager` validates a *string* secret with
 * `bip39.validateMnemonic` and throws "The seed phrase is invalid." on failure —
 * but it accepts a `Uint8Array` as raw seed bytes with NO validation. Hosts here
 * support wallets rooted on an `nsec1…` Nostr key or a raw hex private key (not
 * just BIP-39 phrases), which the native adapters resolved before use. Mirror that
 * resolution and hand the WDK managers bytes, so nsec/hex-rooted wallets connect.
 *
 * Resolution (matches the native spark/arkade client-managers):
 *  - `nsec1…`      → the decoded 32-byte private key (used as the HD master seed)
 *  - 64-hex-chars  → those 32 bytes (used as the HD master seed)
 *  - otherwise     → treated as a BIP-39 mnemonic → 64-byte PBKDF2 seed
 *
 * NOTE ON PARITY: for BIP-39 and nsec/hex wallets the Spark path reproduces the
 * native addresses (spark-sdk receives the same effective seed). Arkade derives
 * HD keys from the seed, so BIP-39 wallets match the native BIP-86 derivation but
 * an nsec/hex-rooted Arkade wallet (native used the raw key as identity) will not.
 */

import { bech32 } from '@scure/base'
import { mnemonicToSeedSync } from '@scure/bip39'
import { hexToBytes } from '@noble/hashes/utils.js'

/** Decode an `nsec1…` bech32 secret into its 32 raw key bytes, or null. */
function nsecToBytes(input: string): Uint8Array | null {
  try {
    const decoded = bech32.decode(input as `${string}1${string}`, 1023)
    if (decoded.prefix !== 'nsec') return null
    const data = bech32.fromWords(decoded.words)
    return Uint8Array.from(data)
  } catch {
    return null
  }
}

/**
 * Resolve a wallet secret (nsec / hex private key / BIP-39 mnemonic) to the seed
 * bytes a WDK `WalletManager` consumes. Never throws on a non-BIP-39 string — it
 * falls through to the mnemonic seed derivation (the host validated the secret at
 * wallet creation).
 */
export function resolveWalletSeed(secret: string): Uint8Array {
  const trimmed = secret.trim()
  if (trimmed.startsWith('nsec1')) {
    const bytes = nsecToBytes(trimmed)
    if (bytes) return bytes
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed.toLowerCase())
  }
  return mnemonicToSeedSync(trimmed)
}
