import { describe, it, expect } from 'vitest'
import { Transaction, p2wpkh, SigHash, bip32Path } from '@scure/btc-signer'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { signPsbt } from '../src/lib/psbt-signer'

/**
 * The dApp-facing PSBT signer must sign a normal owned input, but must NOT sign
 * an input whose sighash flag would let a counterparty rewrite the transaction
 * (SIGHASH_NONE/SINGLE/ANYONECANPAY). @scure/btc-signer enforces this by default
 * (it only permits each input's default sighash); these tests lock that in.
 */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PATH = "m/84'/0'/0'/0/0"

/** Build a single-input, single-output PSBT owned by MNEMONIC's PATH key. */
function buildOwnedPsbt(sighashType?: number): string {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
  const child = root.derive(PATH)
  const pub = child.publicKey!
  const spk = p2wpkh(pub).script

  const tx = new Transaction()
  tx.addInput({
    txid: hexToBytes('11'.repeat(32)),
    index: 0,
    witnessUtxo: { script: spk, amount: 100_000n },
    bip32Derivation: [[pub, { fingerprint: root.fingerprint, path: bip32Path(PATH) }]],
    ...(sighashType != null ? { sighashType } : {}),
  })
  tx.addOutput({ script: spk, amount: 90_000n })
  return bytesToHex(tx.toPSBT())
}

describe('signPsbt', () => {
  it('signs an owned input with the default (SIGHASH_ALL) sighash', () => {
    const res = signPsbt(buildOwnedPsbt(), MNEMONIC)
    expect(res.signedCount).toBe(1)
    expect(res.unchanged).toBe(false)
  })

  it('refuses to sign an owned input flagged SIGHASH_NONE (output-rewrite risk)', () => {
    const res = signPsbt(buildOwnedPsbt(SigHash.NONE), MNEMONIC)
    expect(res.signedCount).toBe(0)
    expect(res.unchanged).toBe(true)
  })

  it('refuses SIGHASH_SINGLE | ANYONECANPAY too', () => {
    const res = signPsbt(buildOwnedPsbt(SigHash.SINGLE_ANYONECANPAY), MNEMONIC)
    expect(res.signedCount).toBe(0)
    expect(res.unchanged).toBe(true)
  })

  it('throws on non-PSBT input', () => {
    expect(() => signPsbt('deadbeef', MNEMONIC)).toThrow(/not a valid PSBT/i)
  })
})
