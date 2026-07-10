import { describe, it, expect } from 'vitest'
import { resolveArkadePrivateKeyHex } from '../src/lib/arkade-client-manager'
import { resolveSparkMnemonicOrSeed } from '../src/lib/spark-client-manager'

/**
 * Fail-loud secret resolution (M2): a corrupted secret must throw, never
 * silently derive a valid-but-different (empty) wallet. `mnemonicToSeedSync`
 * PBKDF2s ANY string, so without explicit validation a typo'd phrase or a
 * bad-checksum nsec resolves to a wallet with no funds — "my funds are gone".
 */

const VALID_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
// last char flipped → checksum fails
const BAD_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe6'
const HEX_KEY = 'a'.repeat(64)

describe('resolveArkadePrivateKeyHex (fail-loud)', () => {
  it('accepts a valid BIP39 mnemonic and a hex key', () => {
    expect(resolveArkadePrivateKeyHex(VALID_MNEMONIC, true)).toMatch(/^[0-9a-f]{64}$/)
    expect(resolveArkadePrivateKeyHex(HEX_KEY, true)).toBe(HEX_KEY)
  })

  it('throws on a bad-checksum nsec instead of falling through to the mnemonic path', () => {
    expect(() => resolveArkadePrivateKeyHex(BAD_NSEC, true)).toThrow(/nsec1/i)
  })

  it('throws on an invalid mnemonic instead of deriving a wrong wallet', () => {
    expect(() => resolveArkadePrivateKeyHex('definitely not a mnemonic', true)).toThrow(/invalid wallet secret/i)
    expect(() =>
      resolveArkadePrivateKeyHex(VALID_MNEMONIC.replace(/about$/, 'abandon'), true),
    ).toThrow(/invalid wallet secret/i)
  })
})

describe('resolveSparkMnemonicOrSeed (fail-loud)', () => {
  it('passes mnemonics/hex through unchanged (SDK validates those itself)', () => {
    expect(resolveSparkMnemonicOrSeed(VALID_MNEMONIC)).toBe(VALID_MNEMONIC)
    expect(resolveSparkMnemonicOrSeed(HEX_KEY)).toBe(HEX_KEY)
  })

  it('throws on a bad-checksum nsec instead of passing it through as a seed', () => {
    expect(() => resolveSparkMnemonicOrSeed(BAD_NSEC)).toThrow(/nsec1/i)
  })
})
