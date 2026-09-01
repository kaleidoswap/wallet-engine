/** TASK A audit probe — fixed: signature strings must have one canonical length. */
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
  it('F6 [FIXED]: a valid 65-byte signature with extra alphabet chars is rejected', () => {
    const sig = signLnMessage('auth challenge', key)
    const mutated = sig + 'ybndr'
    const recoveredOriginal = verifyLnMessage('auth challenge', sig)
    expect(recoveredOriginal).toBe(pub)
    expect(() => verifyLnMessage('auth challenge', mutated)).toThrow(/length/i)
    expect(() => verifyLnMessageFrom('auth challenge', mutated, pub)).toThrow(/length/i)
  })
})
