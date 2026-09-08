/*
 * Regression test for audit finding A-F4 (REPORT.md §2.2, REPORT-2.md §4.2).
 *
 * nsec-rooted wallets are the DEFAULT Arkade wallet type
 * (src/lib/arkade-client-manager.ts header: "new wallets use an nsec root
 * secret"), and a raw 64-hex-char private key is equally supported. Both
 * `connect()` paths resolve those through `resolveWalletSeed` /
 * `resolveArkadePrivateKeyHex`, so such a wallet connects and spends fine.
 *
 * But every signing path resolved the secret with `mnemonicToSeedSync(secret)`
 * instead, which throws "Invalid mnemonic" on anything that is not 12-24
 * wordlist words. So an nsec- or hex-rooted wallet could not sign a message or
 * a PSBT at all — five call sites:
 *
 *   src/lib/psbt-signer.ts            signPsbt()   (used by both Spark signPsbt)
 *   src/adapters/SparkAdapter.ts      signMessage()
 *   src/adapters/ArkadeAdapter.ts     signMessage()
 *   src/adapters/wdk/SparkWdkAdapter.ts   signMessage()
 *   src/adapters/wdk/ArkadeWdkAdapter.ts  signMessage()
 *
 * The correct seed for each shape is whatever `resolveWalletSeed` returns —
 * that is the same resolution `connect()` hands the WDK wallet managers
 * (ArkadeWdkAdapter.ts:128, RlnWdkAdapter.ts:168, SparkWdkAdapter.ts), so the
 * HD tree a PSBT's BIP32 derivations refer to is rooted exactly there.
 */
import { describe, expect, it, vi } from 'vitest'
import { HDKey } from '@scure/bip32'
import { bech32 } from '@scure/base'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { p2wpkh, Transaction } from '@scure/btc-signer'
import { signPsbt } from '../../src/lib/psbt-signer'
import { resolveWalletSeed } from '../../src/lib/wallet-seed'
import { verifyLnMessage } from '../../src/lib/ln-message-sign'

// The three supported wallet-secret shapes.
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const HEX = '11'.repeat(32)
const NSEC = bech32.encode('nsec', bech32.toWords(hexToBytes(HEX)))

const SECRETS: ReadonlyArray<[string, string]> = [
  ['mnemonic', MNEMONIC],
  ['nsec', NSEC],
  ['hex', HEX],
]

/** The message-signing key every adapter derives: m/138'/1 off the wallet root. */
function expectedMessagePubkey(secret: string): string {
  const node = HDKey.fromMasterSeed(resolveWalletSeed(secret)).derive("m/138'/1")
  return bytesToHex(node.publicKey!)
}

function bip32Path(path: string): number[] {
  return path
    .replace(/^m\//, '')
    .split('/')
    .map((p) => (p.endsWith("'") ? parseInt(p) + 0x80000000 : parseInt(p)))
}

/** A single-input PSBT owned by `secret`'s key at PATH, as the wallet resolves it. */
function buildOwnedPsbt(secret: string): string {
  const PATH = "m/84'/1'/0'/0/0"
  const root = HDKey.fromMasterSeed(resolveWalletSeed(secret))
  const child = root.derive(PATH)
  const spk = p2wpkh(child.publicKey!).script
  const tx = new Transaction()
  tx.addInput({
    txid: hexToBytes('22'.repeat(32)),
    index: 0,
    witnessUtxo: { script: spk, amount: 50_000n },
    bip32Derivation: [[child.publicKey!, { fingerprint: root.fingerprint, path: bip32Path(PATH) }]],
  })
  tx.addOutput({ script: spk, amount: 40_000n })
  return bytesToHex(tx.toPSBT())
}

// --- The four adapters need only a connected-looking shell to reach signMessage.
const sparkState = vi.hoisted(() => ({ connected: true }))
vi.mock('../../src/lib/spark-client-manager', () => ({
  sparkClientManager: {
    isInitialized: () => sparkState.connected,
    getWallet: () => ({}),
    initialize: async () => {},
    disconnect: async () => {},
  },
}))
const arkadeState = vi.hoisted(() => ({ connected: true }))
vi.mock('../../src/lib/arkade-client-manager', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    arkadeClientManager: {
      isInitialized: () => arkadeState.connected,
      getWallet: () => ({}),
      initialize: async () => {},
      disconnect: async () => {},
    },
  }
})

import { SparkAdapter } from '../../src/adapters/SparkAdapter'
import { ArkadeAdapter } from '../../src/adapters/ArkadeAdapter'
import { SparkWdkAdapter } from '../../src/adapters/wdk/SparkWdkAdapter'
import { ArkadeWdkAdapter } from '../../src/adapters/wdk/ArkadeWdkAdapter'

describe('A-F4: every wallet-secret shape can sign', () => {
  describe('signPsbt (src/lib/psbt-signer.ts) — shared by both Spark signPsbt paths', () => {
    for (const [shape, secret] of SECRETS) {
      it(`signs a ${shape}-rooted wallet's own PSBT`, () => {
        const result = signPsbt(buildOwnedPsbt(secret), secret)
        expect(result.signedCount, `${shape} input must be signed`).toBe(1)
        expect(result.unchanged).toBe(false)
      })
    }

    it('still refuses a secret that is none of the three shapes', () => {
      // Fail loud rather than PBKDF2 a typo into a different, empty wallet.
      expect(() => signPsbt(buildOwnedPsbt(MNEMONIC), 'not a real secret at all')).toThrow(
        /invalid wallet secret/i,
      )
    })
  })

  const ADAPTERS: ReadonlyArray<[string, (secret: string) => { signMessage(m: string): Promise<string> }]> = [
    ['SparkAdapter', (secret) => Object.assign(new SparkAdapter() as any, { config: { protocol: 'SPARK', mnemonic: secret } })],
    ['ArkadeAdapter', (secret) => Object.assign(new ArkadeAdapter() as any, { config: { protocol: 'ARKADE', mnemonic: secret } })],
    ['SparkWdkAdapter', (secret) => Object.assign(new SparkWdkAdapter() as any, { connected: true, account: {}, mnemonic: secret })],
    ['ArkadeWdkAdapter', (secret) => Object.assign(new ArkadeWdkAdapter() as any, { connected: true, account: {}, mnemonic: secret })],
  ]

  for (const [name, make] of ADAPTERS) {
    describe(`${name}.signMessage`, () => {
      for (const [shape, secret] of SECRETS) {
        it(`signs with the ${shape}-rooted wallet's m/138'/1 key`, async () => {
          const sig = await make(secret).signMessage('prove you own this wallet')
          expect(verifyLnMessage('prove you own this wallet', sig)).toBe(
            expectedMessagePubkey(secret),
          )
        })
      }
    })
  }
})
