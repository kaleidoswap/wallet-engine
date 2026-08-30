/**
 * TASK A audit probe — zbase32Decode accepts trailing garbage when a byte
 * length is given, so verifyLnMessage accepts mutated signature strings.
 */
import { describe, expect, it } from 'vitest'
import { signLnMessage, verifyLnMessage, verifyLnMessageFrom } from '../../src/lib/ln-message-sign'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { bytesToHex } from '@noble/hashes/utils.js'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const key = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/138'/1'").privateKey!
const pub = bytesToHex(
  HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/138'/1'").publicKey!,
)

describe('zbase32 signature malleability', () => {
  it('F6: a valid 65-byte signature with extra alphabet chars appended still verifies', () => {
    const sig = signLnMessage('auth challenge', key)
    // 65 bytes encode to exactly 104 zbase32 chars. Appending alphabet chars
    // is silently discarded by zbase32Decode (written < expectedBytes guard at
    // src/lib/zbase32.ts:58) — no length or padding validation.
    const mutated = sig + 'ybndr'
    const recoveredOriginal = verifyLnMessage('auth challenge', sig)
    const recoveredMutated = verifyLnMessage('auth challenge', mutated)
    expect(recoveredMutated).toBe(recoveredOriginal)
    // And the strict verifier accepts it as the expected signer too.
    expect(() => verifyLnMessageFrom('auth challenge', mutated, pub)).not.toThrow()
  })
})
