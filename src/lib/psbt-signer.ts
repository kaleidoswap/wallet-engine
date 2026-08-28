/**
 * PSBT signing helper: parses a PSBT, derives the keys matching the BIP32
 * derivation paths in its input entries, and signs every signable input.
 *
 * Invariants:
 *  - Never fabricates a signature — returns { unchanged: true } when nothing can
 *    be signed.
 *  - Signs only inputs whose PSBT carries explicit BIP32 metadata; scanning paths
 *    would be O(accounts × gap) and too slow for the background worker.
 *  - Throws on malformed input so the caller can surface an error to the dApp.
 */

import { Transaction } from '@scure/btc-signer'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'

// PSBT magic bytes: 0x70736274ff ("psbt" + separator 0xff)
const PSBT_MAGIC = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff])

function assertPsbtMagic(bytes: Uint8Array): void {
  for (let i = 0; i < PSBT_MAGIC.length; i++) {
    if (bytes[i] !== PSBT_MAGIC[i]) {
      throw new Error('Input is not a valid PSBT (magic bytes mismatch)')
    }
  }
}

/**
 * Convert a raw BIP32 path array (as stored in PSBT key-value pairs) to canonical
 * string form. Each element ≥ 0x80000000 is a hardened step.
 */
function pathToString(pathArr: readonly number[]): string {
  return 'm/' + pathArr.map((n) => (n >= 0x80000000 ? `${n - 0x80000000}'` : String(n))).join('/')
}

export interface PsbtSignResult {
  /** Signed PSBT hex (or the original hex if unchanged). */
  psbt: string
  /** True when no input could be signed (no owned inputs). */
  unchanged: boolean
  /** Number of inputs that were signed. */
  signedCount: number
}

/**
 * Parse and attempt to sign a PSBT with keys derived from a BIP39 mnemonic.
 *
 * @param psbtHex  Hex-encoded PSBT bytes (no 0x prefix).
 * @param mnemonic BIP39 mnemonic for key derivation.
 */
export function signPsbt(psbtHex: string, mnemonic: string): PsbtSignResult {
  const bytes = hexToBytes(psbtHex)
  assertPsbtMagic(bytes)

  let tx: Transaction
  try {
    tx = Transaction.fromPSBT(bytes)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to parse PSBT: ${msg}`)
  }

  const seed = mnemonicToSeedSync(mnemonic)
  const root = HDKey.fromMasterSeed(seed)

  let signedCount = 0

  for (let idx = 0; idx < tx.inputsLength; idx++) {
    const input = tx.getInput(idx)

    // Skip finalized inputs. An empty Uint8Array is truthy, so check length.
    const hasFinalSig = Array.isArray(input.finalScriptSig)
      ? (input.finalScriptSig as unknown[]).length > 0
      : (input.finalScriptSig?.length ?? 0) > 0
    const hasFinalWitness =
      Array.isArray(input.finalScriptWitness) && input.finalScriptWitness.length > 0
    if (hasFinalSig || hasFinalWitness) continue

    // Collect derivation paths from this input. An input may have multiple
    // BIP32_DERIVATION entries (one per required signer in multisig scripts).
    const derivations = input.bip32Derivation ?? []
    const taprootDerivations = input.tapBip32Derivation ?? []

    const allPaths: string[] = [
      ...derivations.map(([, { path }]) => pathToString(path)),
      ...taprootDerivations.map(
        ([
          ,
          {
            der: { path },
          },
        ]) => pathToString(path),
      ),
    ]

    if (allPaths.length === 0) continue

    for (const path of allPaths) {
      let child: HDKey
      try {
        child = root.derive(path)
      } catch {
        continue
      }
      if (!child.privateKey) continue

      try {
        // No `allowedSighash` on purpose: @scure/btc-signer then restricts signing
        // to each input's DEFAULT sighash and throws on anything else, so a
        // dApp-supplied PSBT setting SIGHASH_NONE/SINGLE/ANYONECANPAY on an owned
        // input — which would let the counterparty rewrite outputs — is refused
        // rather than blindly signed. An explicit `[SigHash.ALL]` would be WRONG:
        // it would reject legitimate taproot inputs (default = 0, not ALL).
        tx.signIdx(child.privateKey, idx)
        signedCount++
        break // one signature per input is enough
      } catch {
        // Key didn't match this input (or its sighash is disallowed) — try the
        // next derivation path.
      }
    }
  }

  const unchanged = signedCount === 0
  const resultBytes = tx.toPSBT()
  return {
    psbt: bytesToHex(resultBytes),
    unchanged,
    signedCount,
  }
}

/**
 * Finalize a fully-signed PSBT and extract the raw network transaction, for
 * `webbtc.finalizePsbt`. Throws when the PSBT is malformed or not fully signed, so
 * the dApp gets a clean error rather than a half-finalized transaction.
 */
export function finalizePsbt(psbtHex: string): { txHex: string; txid: string } {
  const bytes = hexToBytes(psbtHex)
  assertPsbtMagic(bytes)

  let tx: Transaction
  try {
    tx = Transaction.fromPSBT(bytes)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to parse PSBT: ${msg}`)
  }

  try {
    tx.finalize()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`PSBT is not fully signed / could not be finalized: ${msg}`)
  }

  // `extract()` returns the raw network transaction bytes once every input is
  // finalized. `tx.id` is the (witness-excluded) txid in display byte order.
  const rawTx = tx.extract()
  return { txHex: bytesToHex(rawTx), txid: tx.id }
}

/**
 * Decode a PSBT into lightweight metadata for the confirmation popup — input and
 * output counts, and estimated value transferred. Never throws.
 */
export function decodePsbtMeta(psbtHex: string): {
  inputCount: number
  outputCount: number
  isValid: boolean
} {
  try {
    const bytes = hexToBytes(psbtHex)
    assertPsbtMagic(bytes)
    const tx = Transaction.fromPSBT(bytes)
    return {
      inputCount: tx.inputsLength,
      outputCount: tx.outputsLength,
      isValid: true,
    }
  } catch {
    return { inputCount: 0, outputCount: 0, isValid: false }
  }
}
