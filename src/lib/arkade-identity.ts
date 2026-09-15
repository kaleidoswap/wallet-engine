/**
 * Arkade identity derivation — and the two incompatible paths in use.
 *
 * | adapter | path | coin type |
 * |---|---|---|
 * | `ArkadeAdapter` (via `arkade-client-manager`) | `m/86'/{coin}'/0'/0/0` | hardened |
 * | `ArkadeWdkAdapter` | `m/86'/{coin}/0'/0/{index}` | **not** hardened |
 *
 * Same mnemonic, two different wallets, no error to say so. Switching adapters
 * on one seed opens an empty wallet with the funds in the derivation it left,
 * so the choice is named by the caller and never defaulted.
 *
 * `WDK_COMPAT` reproduces `@arkade-os/wdk@0.1.4`, unhardened level included,
 * and is verified byte-identical against the live wallets.
 */

import { HDKey } from '@scure/bip32'
import { resolveWalletSeed } from './wallet-seed'

/** Which of the two incompatible derivations to use. Never defaulted. */
export type ArkadeDerivation = 'WDK_COMPAT' | 'BIP86_HARDENED'

/** Coin-type index: 0 for mainnet, 1 for every test network. */
function coinType(network: string | undefined): '0' | '1' {
  return ['bitcoin', 'mainnet'].includes(String(network)) ? '0' : '1'
}

/** The BIP-32 path. `WDK_COMPAT`'s unhardened coin type is deliberate. */
export function arkadeDerivationPath(
  derivation: ArkadeDerivation,
  network: string | undefined,
  index = 0,
): string {
  const coin = coinType(network)
  return derivation === 'WDK_COMPAT'
    ? `m/86'/${coin}/0'/0/${index}`
    : `m/86'/${coin}'/0'/0/${index}`
}

/**
 * Derive the 32-byte private key for an Arkade account. Non-mnemonic secrets
 * are HD-derived too — unusual, but it is what the existing wallets were built
 * with.
 */
export function deriveArkadeIdentityKey(
  secret: string,
  options: { derivation: ArkadeDerivation; network?: string; index?: number },
): Uint8Array {
  const path = arkadeDerivationPath(options.derivation, options.network, options.index ?? 0)
  const master = HDKey.fromMasterSeed(resolveWalletSeed(secret))
  const hd = master.derive(path)
  if (!hd.privateKey) throw new Error(`Arkade identity derivation produced no private key at ${path}`)
  return hd.privateKey
}
