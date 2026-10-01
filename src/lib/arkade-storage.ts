/**
 * Storage repositories for an Arkade wallet.
 *
 * `@arkade-os/wdk` substituted in-memory repositories when given no `storage`,
 * which wiped the contract rows the signer-rotation migration reads on every
 * connect. Pass repositories that persist where the runtime can.
 */

/** The SDK namespace, kept off the static import graph. */
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

/** Best repositories this runtime supports; a host's own always wins. */
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

export const NON_PERSISTENT_STORAGE_REASON =
  'Arkade wallet state is in-memory: VTXO and contract rows are rebuilt on every connect, so signer-rotation history does not survive a restart. ' +
  'Pass ArkadeConfig.storage with repositories that persist on this runtime.'
