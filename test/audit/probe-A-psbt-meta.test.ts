/**
 * TASK A audit probe — decodePsbtMeta (src/lib/psbt-signer.ts:185) is
 * documented as the metadata source "for display in the confirmation popup"
 * and its doc comment promises "estimated value transferred", but it returns
 * only input/output COUNTS — a host using it cannot show amount or destination
 * for a drain PSBT.
 */
import { describe, expect, it } from 'vitest'
import { Transaction, p2wpkh } from '@scure/btc-signer'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { decodePsbtMeta } from '../../src/lib/psbt-signer'

describe('decodePsbtMeta confirmation surface', () => {
  it('F7: a 100k-sat drain to an attacker script is indistinguishable from a 1-in-1-out self-transfer', () => {
    const root = HDKey.fromMasterSeed(
      mnemonicToSeedSync(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      ),
    )
    const own = p2wpkh(root.derive("m/84'/0'/0'/0/0").publicKey!).script
    const attacker = p2wpkh(new Uint8Array(33).fill(2)).script

    const tx = new Transaction()
    tx.addInput({
      txid: hexToBytes('33'.repeat(32)),
      index: 0,
      witnessUtxo: { script: own, amount: 100_000n },
    })
    tx.addOutput({ script: attacker, amount: 95_000n }) // everything to the attacker

    const meta = decodePsbtMeta(bytesToHex(tx.toPSBT()))
    // The entire review surface: counts + validity. No amount, no destination,
    // no fee — despite the doc comment advertising "estimated value transferred".
    expect(meta).toEqual({ inputCount: 1, outputCount: 1, isValid: true })
    expect('valueSat' in meta || 'amountSat' in meta || 'destinations' in meta).toBe(false)
  })
})
