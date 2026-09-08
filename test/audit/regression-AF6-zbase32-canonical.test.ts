import { describe, expect, it } from 'vitest'
import { zbase32Decode } from '../../src/lib/zbase32'
import { signLnMessage, verifyLnMessage } from '../../src/lib/ln-message-sign'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const key = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/138'/1'").privateKey!

describe('A-F6: canonical zbase32 signatures', () => {
  it('rejects input longer than the explicitly requested byte length', () => {
    expect(() => zbase32Decode('y'.repeat(105), 65)).toThrow(/length/i)
  })

  it('does not verify an alphabet-only suffix appended to a valid signature', () => {
    const signature = signLnMessage('auth challenge', key)
    expect(() => verifyLnMessage('auth challenge', signature + 'ybndr')).toThrow(/length/i)
  })
})
