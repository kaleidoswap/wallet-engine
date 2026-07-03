/**
 * PSBT signing helper.
 *
 * Parses an incoming PSBT, derives the set of private keys that correspond
 * to BIP32 derivation paths embedded in the PSBT's input entries, attempts
 * to sign every signable input, and returns the result.
 *
 * Design invariants:
 *  - Never fabricates a signature: if no input can be signed (no BIP32 paths
 *    present, no matching key), returns { unchanged: true }.
 *  - Does NOT scan derivation paths — only signs inputs whose PSBT already
 *    carries explicit BIP32 derivation metadata. Scanning would be O(accounts
 *    × gap) and too slow for the background service worker.
 *  - Throws on malformed / non-PSBT input so the caller can surface an error
 *    to the dApp rather than silently returning garbage.
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
 * Convert a raw BIP32 path array (as stored in PSBT key-value pairs) to the
 * canonical string form. Each element ≥ 0x80000000 is a hardened step.
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
 * Parse and attempt to sign a PSBT using keys derived from the provided
 * BIP39 mnemonic.
 *
 * @param psbtHex  Hex-encoded PSBT bytes (without 0x prefix).
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
        tx.signIdx(child.privateKey, idx)
        signedCount++
        break // one signature per input is enough
      } catch {
        // Key didn't match this input — try the next derivation path.
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
 * Finalize a fully-signed PSBT and extract the raw network transaction.
 *
 * Used by `webbtc.finalizePsbt`: a dApp hands back a PSBT that already carries
 * all required signatures and asks the wallet to assemble the final scriptSig /
 * witness and return the broadcastable transaction hex.
 *
 * Throws when the PSBT is malformed or not fully signed (btc-signer's
 * `finalize()` rejects an input that still lacks a signature) so the dApp gets
 * a clean error rather than a half-finalized transaction.
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
 * Decode a PSBT and return lightweight metadata for display in the
 * confirmation popup — input count, output count, and estimated value
 * transferred (sum of non-change outputs where possible).
 *
 * Never throws — returns safe defaults on malformed input.
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
