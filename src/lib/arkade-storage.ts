/**
 * Storage repositories for an Arkade wallet.
 *
 * `@arkade-os/wdk` substitutes in-memory repositories whenever its caller does
 * not pass `storage`, and says so in its own comment: *"In-memory storage means
 * VTXO state is lost on app restart."* We never passed `storage`, so every
 * Arkade wallet the engine built rebuilt its wallet **and contract**
 * repositories from nothing on each connect.
 *
 * The contract repository is the part that matters. It holds the boarding and
 * offchain contract rows a signer rotation writes, and the deprecated-signer
 * migration reads them back to find coins minted under an old server key. Wiped
 * on every connect, that history cannot survive a restart, and the rotation the
 * wallet performed yesterday is invisible to it today.
 *
 * So pass repositories that persist where the runtime can: IndexedDB in a
 * browser or service worker, which is what `arkade-os/wallet` uses. Where it
 * cannot — Node, a worklet — in-memory is the honest fallback, but the caller
 * is told rather than left to infer it from a balance that resets.
 */

/** The SDK namespace, passed in so this module stays off the static import graph. */
export interface ArkadeStorageSdk {
  IndexedDBWalletRepository?: new () => unknown
  IndexedDBContractRepository?: new () => unknown
  InMemoryWalletRepository: new () => unknown
  InMemoryContractRepository: new () => unknown
}

export interface ArkadeStorage {
  walletRepository: unknown
  contractRepository: unknown
}

export interface ResolvedArkadeStorage {
  storage: ArkadeStorage
  /** True when the repositories survive a restart. */
  persistent: boolean
}

/** True when this runtime has a usable IndexedDB (browser, service worker). */
function hasIndexedDB(): boolean {
  return typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined'
}

/**
 * Pick the best repositories this runtime supports, unless the host supplied
 * its own — a host that brings storage knows better than we do.
 */
export function resolveArkadeStorage(
  sdk: ArkadeStorageSdk,
  injected?: ArkadeStorage,
): ResolvedArkadeStorage {
  if (injected?.walletRepository && injected?.contractRepository) {
    return { storage: injected, persistent: true }
  }
  if (hasIndexedDB() && sdk.IndexedDBWalletRepository && sdk.IndexedDBContractRepository) {
    return {
      storage: {
        walletRepository: new sdk.IndexedDBWalletRepository(),
        contractRepository: new sdk.IndexedDBContractRepository(),
      },
      persistent: true,
    }
  }
  return {
    storage: {
      walletRepository: new sdk.InMemoryWalletRepository(),
      contractRepository: new sdk.InMemoryContractRepository(),
    },
    persistent: false,
  }
}

/** What a host loses with in-memory repositories, and how to stop losing it. */
export const NON_PERSISTENT_STORAGE_REASON =
  'Arkade wallet state is in-memory: VTXO and contract rows are rebuilt on every connect, so signer-rotation history does not survive a restart. ' +
  'Pass ArkadeConfig.storage with repositories that persist on this runtime.'
