/**
 * Arkade identity derivation — and the two incompatible paths already in use.
 *
 * The engine ships two Arkade adapters and they derive **different keys from
 * the same mnemonic**, because their coin-type level differs in hardening:
 *
 * | adapter | path | coin type |
 * |---|---|---|
 * | `ArkadeAdapter` (SDK-direct, via `arkade-client-manager`) | `m/86'/{coin}'/0'/0/0` | hardened |
 * | `ArkadeWdkAdapter` (via `@arkade-os/wdk`) | `m/86'/{0\|1}/0'/0/{index}` | **not** hardened |
 *
 * Two different wallets, two different address sets, no error to say so. A host
 * that switched adapters on one mnemonic would open an empty wallet and its
 * funds would sit in the derivation it left. That has to be a decision a caller
 * makes by name, which is what `ArkadeDerivation` is for — never a default that
 * follows from which adapter happens to be constructing.
 *
 * `WDK_COMPAT` reproduces `@arkade-os/wdk@0.1.4`'s
 * `wallet-manager-arkade.js:209` exactly, unhardened level included. It is
 * verified against the live mutinynet wallets — the x-only key it derives is
 * byte-identical to the one the WDK built — so the Arkade path can move off the
 * WDK without a single address changing.
 */

import { HDKey } from '@scure/bip32'
import { resolveWalletSeed } from './wallet-seed'

/** Which of the two incompatible derivations to use. Never defaulted. */
export type ArkadeDerivation = 'WDK_COMPAT' | 'BIP86_HARDENED'

/** Coin-type index: 0 for mainnet, 1 for every test network. */
function coinType(network: string | undefined): '0' | '1' {
  return ['bitcoin', 'mainnet'].includes(String(network)) ? '0' : '1'
}

/**
 * The BIP-32 path for an Arkade account.
 *
 * `WDK_COMPAT` leaves the coin-type level unhardened. That is not a typo here:
 * it is what the WDK does, and matching it byte-for-byte is the whole point.
 */
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
 * Derive the 32-byte private key for an Arkade account.
 *
 * Accepts whatever `resolveWalletSeed` accepts — mnemonic, `nsec1…`, or 64-char
 * hex. The non-mnemonic forms are already a single key, and the WDK still runs
 * them through the same HD derivation, so this does too: a raw key used as an
 * HD seed is unusual but it is what the existing wallets were built with.
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
