/**
 * AUDIT N3 (run 2, Phase 3 concurrency) — `ArkadeClientManager`'s incoming-funds
 * listener guard is set only AFTER the async subscribe resolves, so the guard
 * does not guard.
 *
 * `startIncomingFundsListener()` checks `_listenerStarted` synchronously but
 * assigns it (and `_stopIncomingFunds`) inside the `.then()` of
 * `wallet.notifyIncomingFunds(...)`. Three consequences, all reproduced below:
 *
 *  a) ACCUMULATION — two calls before the first subscribe resolves both pass the
 *     guard, so two subscriptions exist and `_stopIncomingFunds` retains only
 *     the last stop function. The earlier one can never be stopped: repeated
 *     connect cycles grow it without bound.
 *  b) POST-TEARDOWN INSTALL — a `disconnect()` that lands while the subscribe is
 *     pending runs `stopIncomingFundsListener()` on a null stop function; the
 *     `.then()` then installs a live listener against a torn-down wallet, and
 *     the host callback fires for a wallet the host believes is locked.
 *  c) WRONG-WALLET DELIVERY — after (b) `_listenerStarted` is true, so the NEXT
 *     wallet's `startIncomingFundsListener()` is refused as a duplicate. Wallet
 *     A's live subscription is then the only one, delivering A's incoming-funds
 *     notifications into wallet B's session callback.
 *
 * Deterministic: driven by explicit deferreds inside the mocked SDK.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const sdkState = {
  pendingCreate: null as null | { resolve: (w: object) => void },
  /** One entry per notifyIncomingFunds() call. */
  subs: [] as Array<{
    cb: (n: unknown) => void
    stopped: boolean
    release: () => void
  }>,
}

vi.mock('@arkade-os/sdk', () => {
  class FakeSingleKey {
    static fromHex(_hex: string) {
      return { xOnlyPublicKey: async () => new Uint8Array(32).fill(7) }
    }
  }
  class FakeMnemonicIdentity {
    static fromMnemonic(_m: string, _o: unknown) {
      return { xOnlyPublicKey: async () => new Uint8Array(32).fill(8) }
    }
  }
  class FakeRepo {
    constructor(_dbName: string) {}
  }
  const Wallet = {
    create: (_cfg: unknown) =>
      new Promise<object>((resolve) => {
        sdkState.pendingCreate = { resolve }
      }),
  }
  return {
    Wallet,
    SingleKey: FakeSingleKey,
    MnemonicIdentity: FakeMnemonicIdentity,
    IndexedDBWalletRepository: FakeRepo,
    IndexedDBContractRepository: FakeRepo,
    VtxoManager: class {},
    RestDelegatorProvider: class {
      constructor(_url: string) {}
    },
  }
})

import { arkadeClientManager } from '../../src/lib/arkade-client-manager'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const MNEMONIC_B =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'

function arkCfg(mnemonic: string) {
  return {
    protocol: 'ARKADE',
    network: 'signet',
    mnemonic,
    arkServerUrl: 'https://ark.example',
    esploraUrl: 'https://esplora.example',
  } as never
}

/** Arkade wallet whose notifyIncomingFunds() parks until explicitly released. */
function fakeArkWallet(marker: string) {
  return {
    marker,
    getVtxoManager: async () => ({ dispose: async () => {} }),
    getContractManager: async () => ({ refreshVtxos: async () => {} }),
    notifyIncomingFunds: (cb: (n: unknown) => void) =>
      new Promise<() => void>((resolve) => {
        const entry = {
          cb,
          stopped: false,
          release: () =>
            resolve(() => {
              entry.stopped = true
            }),
        }
        sdkState.subs.push(entry)
      }),
  }
}

async function connect(mnemonic: string, marker: string): Promise<void> {
  const init = arkadeClientManager.initialize(arkCfg(mnemonic))
  await vi.waitFor(() => expect(sdkState.pendingCreate).not.toBeNull())
  sdkState.pendingCreate!.resolve(fakeArkWallet(marker))
  sdkState.pendingCreate = null
  await init
}

afterEach(() => {
  arkadeClientManager.reset()
  sdkState.pendingCreate = null
  sdkState.subs.length = 0
})

describe('N3: arkade incoming-funds listener lifecycle', () => {
  it('a) two starts before the first subscribe resolves must not create two subscriptions', async () => {
    await connect(MNEMONIC, 'ARK_A')

    arkadeClientManager.startIncomingFundsListener(() => {})
    arkadeClientManager.startIncomingFundsListener(() => {})

    // The duplicate guard must have refused the second call.
    expect(sdkState.subs).toHaveLength(1)
  })

  it('b) a disconnect() racing the subscribe must not leave a live listener behind', async () => {
    await connect(MNEMONIC, 'ARK_A')

    const seen: unknown[] = []
    arkadeClientManager.startIncomingFundsListener((n) => seen.push(n))
    expect(sdkState.subs).toHaveLength(1)
    const sub = sdkState.subs[0]

    // Host locks the wallet while notifyIncomingFunds() is still pending.
    await arkadeClientManager.disconnect()
    expect(arkadeClientManager.isInitialized()).toBe(false)

    // The subscription lands after teardown.
    sub.release()
    await vi.waitFor(() => expect(sub.stopped).toBe(true))

    // Nothing may be delivered against a torn-down wallet.
    sub.cb({ vtxos: ['post-teardown'] })
    expect(seen).toEqual([])
  })

  it('c) after a teardown race, the NEXT wallet still gets its own listener', async () => {
    await connect(MNEMONIC, 'ARK_A')

    const seenA: unknown[] = []
    arkadeClientManager.startIncomingFundsListener((n) => seenA.push(n))
    const subA = sdkState.subs[0]

    await arkadeClientManager.disconnect()
    subA.release() // A's subscribe resolves after teardown
    await vi.waitFor(() => expect(subA.stopped).toBe(true))

    // Wallet B connects and registers its own listener.
    await connect(MNEMONIC_B, 'ARK_B')
    const seenB: unknown[] = []
    arkadeClientManager.startIncomingFundsListener((n) => seenB.push(n))

    // B must actually be subscribed — not silently refused as a duplicate.
    expect(sdkState.subs.length).toBeGreaterThan(1)
    const subB = sdkState.subs[sdkState.subs.length - 1]
    subB.release()
    await vi.waitFor(() => expect(subB.stopped).toBe(false))

    subB.cb({ vtxos: ['for-B'] })
    expect(seenB).toEqual([{ vtxos: ['for-B'] }])
    // And wallet A's torn-down subscription must not deliver into B's session.
    subA.cb({ vtxos: ['for-A'] })
    expect(seenB).toEqual([{ vtxos: ['for-B'] }])
    expect(seenA).toEqual([])
  })
})
