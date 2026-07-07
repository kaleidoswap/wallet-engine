import { describe, it, expect } from 'vitest'
import { resolveWalletSeed } from '../src/lib/wallet-seed'

/**
 * resolveWalletSeed is the single choke point that turns a stored wallet secret
 * into HD seed bytes. Because `mnemonicToSeedSync` PBKDF2s *any* string without
 * validation, a corrupted secret must fail LOUD here rather than silently derive
 * a valid-but-different (empty) wallet.
 */
describe('resolveWalletSeed', () => {
  // BIP-39 test vector (valid English mnemonic).
  const VALID_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

  it('derives a 64-byte seed from a valid BIP-39 mnemonic', () => {
    const seed = resolveWalletSeed(VALID_MNEMONIC)
    expect(seed).toBeInstanceOf(Uint8Array)
    expect(seed.length).toBe(64)
  })

  it('accepts a 64-char hex private key as raw seed bytes', () => {
    const hex = 'a'.repeat(64)
    const seed = resolveWalletSeed(hex)
    expect(seed.length).toBe(32)
  })

  it('throws on an invalid/typo\'d mnemonic instead of silently deriving a wrong wallet', () => {
    // Same phrase with the last word swapped for one that breaks the checksum.
    const bad = VALID_MNEMONIC.replace(/about$/, 'zoo')
    expect(() => resolveWalletSeed(bad)).toThrow(/invalid wallet secret/i)
  })

  it('throws on arbitrary junk that is none of the three supported forms', () => {
    expect(() => resolveWalletSeed('not a real secret at all')).toThrow(/invalid wallet secret/i)
  })

  it('throws on an nsec1… string that does not decode to a 32-byte key', () => {
    expect(() => resolveWalletSeed('nsec1notvalidbech32')).toThrow(/nsec/i)
  })
})
