import { afterEach, describe, expect, it } from 'vitest'
import {
  NON_PERSISTENT_STORAGE_REASON,
  resolveArkadeStorage,
  type ArkadeStorageSdk,
} from '../src/lib/arkade-storage'

class IdbWallet {}
class IdbContract {}
class MemWallet {}
class MemContract {}

const fullSdk: ArkadeStorageSdk = {
  IndexedDBWalletRepository: IdbWallet,
  IndexedDBContractRepository: IdbContract,
  InMemoryWalletRepository: MemWallet,
  InMemoryContractRepository: MemContract,
}

const scope = globalThis as { indexedDB?: unknown }
const original = Object.prototype.hasOwnProperty.call(globalThis, 'indexedDB') ? scope.indexedDB : undefined
const hadIndexedDB = Object.prototype.hasOwnProperty.call(globalThis, 'indexedDB')

describe('resolveArkadeStorage', () => {
  afterEach(() => {
    if (hadIndexedDB) scope.indexedDB = original
    else delete scope.indexedDB
  })

  it('prefers IndexedDB where the runtime has it', () => {
    scope.indexedDB = {}
    const { storage, persistent } = resolveArkadeStorage(fullSdk)

    expect(storage.walletRepository).toBeInstanceOf(IdbWallet)
    expect(storage.contractRepository).toBeInstanceOf(IdbContract)
    expect(persistent).toBe(true)
  })

  it('falls back to in-memory on Node, and says it is not persistent', () => {
    delete scope.indexedDB
    const { storage, persistent } = resolveArkadeStorage(fullSdk)

    expect(storage.walletRepository).toBeInstanceOf(MemWallet)
    expect(storage.contractRepository).toBeInstanceOf(MemContract)
    // The flag is what drives the host-visible warning; silence is what cost us.
    expect(persistent).toBe(false)
  })

  it('falls back when the SDK has no IndexedDB repositories to offer', () => {
    scope.indexedDB = {}
    const { storage, persistent } = resolveArkadeStorage({
      InMemoryWalletRepository: MemWallet,
      InMemoryContractRepository: MemContract,
    })

    expect(storage.walletRepository).toBeInstanceOf(MemWallet)
    expect(persistent).toBe(false)
  })

  it("takes the host's own repositories over anything it would pick", () => {
    scope.indexedDB = {}
    const injected = { walletRepository: { mine: true }, contractRepository: { mine: true } }
    const { storage, persistent } = resolveArkadeStorage(fullSdk, injected)

    expect(storage).toBe(injected)
    expect(persistent).toBe(true)
  })

  it('ignores a half-supplied injection rather than building a broken wallet', () => {
    scope.indexedDB = {}
    const { storage } = resolveArkadeStorage(fullSdk, { walletRepository: {}, contractRepository: undefined as never })

    expect(storage.walletRepository).toBeInstanceOf(IdbWallet)
  })

  it('names the consequence and the remedy', () => {
    expect(NON_PERSISTENT_STORAGE_REASON).toContain('signer-rotation history')
    expect(NON_PERSISTENT_STORAGE_REASON).toContain('ArkadeConfig.storage')
  })
})
