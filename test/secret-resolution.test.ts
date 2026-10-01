import { describe, it, expect } from 'vitest'
import { resolveArkadePrivateKeyHex } from '../src/lib/arkade-client-manager'
import { resolveSparkMnemonicOrSeed } from '../src/lib/spark-client-manager'
import { BIP39_TEST_VECTOR_MNEMONIC, HEX_KEY_ALL_A, INVALID_NSEC } from './fixtures/mnemonics'

/**
 * Fail-loud secret resolution (M2): a corrupted secret must throw, never silently
 * derive a valid-but-different (empty) wallet. `mnemonicToSeedSync` PBKDF2s ANY
 * string, so without validation a typo'd phrase resolves to a wallet with no funds.
 */

const BAD_NSEC = INVALID_NSEC
const HEX_KEY = HEX_KEY_ALL_A

describe('resolveArkadePrivateKeyHex (fail-loud)', () => {
  it('accepts a valid BIP39 mnemonic and a hex key', () => {
    expect(resolveArkadePrivateKeyHex(BIP39_TEST_VECTOR_MNEMONIC, true)).toMatch(/^[0-9a-f]{64}$/)
    expect(resolveArkadePrivateKeyHex(HEX_KEY, true)).toBe(HEX_KEY)
  })

  it('throws on a bad-checksum nsec instead of falling through to the mnemonic path', () => {
    expect(() => resolveArkadePrivateKeyHex(BAD_NSEC, true)).toThrow(/nsec1/i)
  })

  it('throws on an invalid mnemonic instead of deriving a wrong wallet', () => {
    expect(() => resolveArkadePrivateKeyHex('definitely not a mnemonic', true)).toThrow(/invalid wallet secret/i)
    expect(() =>
      resolveArkadePrivateKeyHex(BIP39_TEST_VECTOR_MNEMONIC.replace(/about$/, 'abandon'), true),
    ).toThrow(/invalid wallet secret/i)
  })
})

describe('resolveSparkMnemonicOrSeed (fail-loud)', () => {
  it('passes mnemonics/hex through unchanged (SDK validates those itself)', () => {
    expect(resolveSparkMnemonicOrSeed(BIP39_TEST_VECTOR_MNEMONIC)).toBe(BIP39_TEST_VECTOR_MNEMONIC)
    expect(resolveSparkMnemonicOrSeed(HEX_KEY)).toBe(HEX_KEY)
  })

  it('throws on a bad-checksum nsec instead of passing it through as a seed', () => {
    expect(() => resolveSparkMnemonicOrSeed(BAD_NSEC)).toThrow(/nsec1/i)
  })
})
