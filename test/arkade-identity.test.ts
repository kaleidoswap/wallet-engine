import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  arkadeDerivationPath,
  deriveArkadeIdentityKey,
  type ArkadeDerivation,
} from '../src/lib/arkade-identity'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const xonly = (secret: string, derivation: ArkadeDerivation, network?: string, index?: number) =>
  hex.encode(schnorr.getPublicKey(deriveArkadeIdentityKey(secret, { derivation, network, index })))

describe('arkade identity derivation', () => {
  it('reproduces the WDK path, unhardened coin type and all', () => {
    expect(arkadeDerivationPath('WDK_COMPAT', 'signet')).toBe("m/86'/1/0'/0/0")
    expect(arkadeDerivationPath('WDK_COMPAT', 'mainnet')).toBe("m/86'/0/0'/0/0")
    expect(arkadeDerivationPath('WDK_COMPAT', 'signet', 3)).toBe("m/86'/1/0'/0/3")
  })

  it('hardens the coin type for the BIP86 path the SDK-direct adapter uses', () => {
    expect(arkadeDerivationPath('BIP86_HARDENED', 'signet')).toBe("m/86'/1'/0'/0/0")
    expect(arkadeDerivationPath('BIP86_HARDENED', 'mainnet')).toBe("m/86'/0'/0'/0/0")
  })

  it('treats any non-mainnet name as a test network', () => {
    for (const net of ['signet', 'testnet', 'regtest', 'mutinynet', undefined]) {
      expect(arkadeDerivationPath('WDK_COMPAT', net)).toBe("m/86'/1/0'/0/0")
    }
    for (const net of ['mainnet', 'bitcoin']) {
      expect(arkadeDerivationPath('WDK_COMPAT', net)).toBe("m/86'/0/0'/0/0")
    }
  })

  // Frozen from the current @arkade-os/wdk@0.1.4 behaviour. These are the
  // values that keep existing wallets reachable; if one changes, every address
  // that adapter ever handed out changes with it.
  it('derives the frozen WDK_COMPAT keys', () => {
    expect(xonly(MNEMONIC, 'WDK_COMPAT', 'mainnet', 0)).toBe(
      '508540e92ece36148463bacdd289402dd5b174435aa5ea53081d327277923933',
    )
    expect(xonly(MNEMONIC, 'WDK_COMPAT', 'signet', 0)).toBe(
      '017618eea82a30e95579d6f60cd99b8e8be874d368425c571d244e8bb6c1f0a9',
    )
    expect(xonly(MNEMONIC, 'WDK_COMPAT', 'signet', 3)).toBe(
      '0b7001a4db7475cbb3a64da71906fa5523c74b9c91aebd5902086858d1e49109',
    )
  })

  it('the two derivations disagree — which is the whole reason to name them', () => {
    expect(xonly(MNEMONIC, 'WDK_COMPAT', 'signet')).not.toBe(xonly(MNEMONIC, 'BIP86_HARDENED', 'signet'))
    expect(xonly(MNEMONIC, 'WDK_COMPAT', 'mainnet')).not.toBe(xonly(MNEMONIC, 'BIP86_HARDENED', 'mainnet'))
  })

  it('separates accounts by index and by network', () => {
    const a = xonly(MNEMONIC, 'WDK_COMPAT', 'signet', 0)
    expect(a).not.toBe(xonly(MNEMONIC, 'WDK_COMPAT', 'signet', 1))
    expect(a).not.toBe(xonly(MNEMONIC, 'WDK_COMPAT', 'mainnet', 0))
  })

  it('accepts the non-mnemonic secrets the existing wallets were built with', () => {
    const hexKey = '1'.repeat(64)
    expect(() => deriveArkadeIdentityKey(hexKey, { derivation: 'WDK_COMPAT', network: 'signet' })).not.toThrow()
    // Still HD-derived, so it is NOT the raw key handed straight to the identity.
    expect(hex.encode(deriveArkadeIdentityKey(hexKey, { derivation: 'WDK_COMPAT', network: 'signet' }))).not.toBe(hexKey)
  })

  it('refuses a secret that is not a valid mnemonic, nsec or hex key', () => {
    expect(() => deriveArkadeIdentityKey('not a wallet secret', { derivation: 'WDK_COMPAT' })).toThrow()
  })
})
