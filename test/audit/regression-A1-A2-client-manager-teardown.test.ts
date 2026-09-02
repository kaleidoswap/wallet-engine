import { afterEach, describe, expect, it } from 'vitest'
import { sparkClientManager } from '../../src/lib/spark-client-manager'
import type { SparkConfig } from '../../src/types/spark'

/**
 * Audit findings A1 + A2 — SparkClientManager's init dedupe and teardown.
 *
 * A1: `initialize()` returned any in-flight promise regardless of which wallet
 *     it was for, so a wallet switch during a pending SDK handshake left wallet
 *     B's session running on wallet A's wallet.
 * A2: `disconnect()`/`reset()` could not cancel an in-flight `_doInitialize`,
 *     which then installed the wallet AND its mnemonic-bearing config *after*
 *     teardown had completed — a locked wallet became live and signing-capable.
 */
function cfg(mnemonic: string): SparkConfig {
  return { protocol: 'SPARK', network: 'regtest', mnemonic } as SparkConfig
}
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}
const fakeWallet = (marker: string) => ({ marker, cleanupConnections: async () => {} })

afterEach(() => sparkClientManager.reset())

describe('A1: initialize() must not hand back another wallet\'s in-flight init', () => {
  it('a wallet switch mid-handshake never yields the previous wallet', async () => {
    const a = deferred<{ wallet: object }>()
    const b = deferred<{ wallet: object }>()
    sparkClientManager.setSdkFactory({
      initializeWallet: ({ mnemonicOrSeed }: any) =>
        String(mnemonicOrSeed).includes('seed-a') ? a.promise : b.promise,
    } as any)

    const initA = sparkClientManager.initialize(cfg('seed-a'))
    await sparkClientManager.disconnect()
    const initB = sparkClientManager.initialize(cfg('seed-b'))

    a.resolve({ wallet: fakeWallet('WALLET_A') })
    await initA.catch(() => {})
    b.resolve({ wallet: fakeWallet('WALLET_B') })
    await initB

    // B's session must be on B's wallet — never A's.
    expect((sparkClientManager.getWallet() as { marker: string }).marker).toBe('WALLET_B')
  })

  // The case above routes through disconnect(), so it is really the A2
  // generation guard doing the work — reverting the wallet-identity KEY alone
  // still passes it. This one exercises A1 on its own: a bare wallet switch,
  // no teardown, while A's handshake is still pending. That is the sequence the
  // finding describes ("switching wallets while wallet A's SDK handshake was
  // still pending handed wallet B's caller A's promise"), and nothing covered it
  // until the post-merge revert-proof looked for a failing test and found none.
  it('a wallet switch mid-handshake with NO disconnect still binds to the new wallet', async () => {
    const a = deferred<{ wallet: object }>()
    const b = deferred<{ wallet: object }>()
    const seedsSeen: string[] = []
    sparkClientManager.setSdkFactory({
      initializeWallet: ({ mnemonicOrSeed }: any) => {
        seedsSeen.push(String(mnemonicOrSeed))
        return String(mnemonicOrSeed).includes('seed-a') ? a.promise : b.promise
      },
    } as any)

    const initA = sparkClientManager.initialize(cfg('seed-a'))
    // No disconnect(): straight to wallet B while A is still in flight.
    const initB = sparkClientManager.initialize(cfg('seed-b'))
    expect(initA, "B's caller must not be handed A's in-flight promise").not.toBe(initB)

    a.resolve({ wallet: fakeWallet('WALLET_A') })
    await initA.catch(() => {})
    b.resolve({ wallet: fakeWallet('WALLET_B') })
    await initB

    // B's own secret must have reached the SDK — not just A's, reused.
    expect(seedsSeen).toContain('seed-b')
    expect((sparkClientManager.getWallet() as { marker: string }).marker).toBe('WALLET_B')
    expect(sparkClientManager.getConfig()?.network).toBe('regtest')
  })

  it('concurrent initialize() for the SAME wallet still shares one handshake', async () => {
    const a = deferred<{ wallet: object }>()
    let calls = 0
    sparkClientManager.setSdkFactory({
      initializeWallet: () => { calls++; return a.promise },
    } as any)

    const p1 = sparkClientManager.initialize(cfg('seed-a'))
    const p2 = sparkClientManager.initialize(cfg('seed-a'))
    expect(p1, 'same config must dedupe onto one promise').toBe(p2)
    a.resolve({ wallet: fakeWallet('WALLET_A') })
    await p1
    expect(calls, 'only one SDK handshake').toBe(1)
  })
})

describe('A2: a teardown during an in-flight init must not be undone by it', () => {
  it('disconnect() while initialize() is pending leaves the wallet torn down', async () => {
    const a = deferred<{ wallet: object }>()
    sparkClientManager.setSdkFactory({ initializeWallet: () => a.promise } as any)

    const init = sparkClientManager.initialize(cfg('seed-a'))
    await sparkClientManager.disconnect()
    expect(sparkClientManager.isInitialized()).toBe(false)

    a.resolve({ wallet: fakeWallet('WALLET_A') })
    await init.catch(() => {})

    expect(sparkClientManager.isInitialized(), 'a locked wallet must stay locked').toBe(false)
    expect(() => sparkClientManager.getWallet()).toThrow()
    // The mnemonic-bearing config must not come back either.
    expect(sparkClientManager.getConfig()).toBeNull()
  })

  it('reset() while initialize() is pending leaves the wallet torn down', async () => {
    const a = deferred<{ wallet: object }>()
    sparkClientManager.setSdkFactory({ initializeWallet: () => a.promise } as any)

    const init = sparkClientManager.initialize(cfg('seed-a'))
    sparkClientManager.reset()
    a.resolve({ wallet: fakeWallet('WALLET_A') })
    await init.catch(() => {})

    expect(sparkClientManager.isInitialized()).toBe(false)
    expect(sparkClientManager.getConfig()).toBeNull()
  })

  it('the abandoned wallet gets its connections cleaned up', async () => {
    const a = deferred<{ wallet: object }>()
    let cleaned = false
    sparkClientManager.setSdkFactory({ initializeWallet: () => a.promise } as any)

    const init = sparkClientManager.initialize(cfg('seed-a'))
    await sparkClientManager.disconnect()
    a.resolve({ wallet: { marker: 'X', cleanupConnections: async () => { cleaned = true } } })
    await init.catch(() => {})
    expect(cleaned, 'an orphaned wallet must not be left holding sockets').toBe(true)
  })

  it('an ordinary initialize with no teardown still works', async () => {
    sparkClientManager.setSdkFactory({
      initializeWallet: async () => ({ wallet: fakeWallet('WALLET_A') }),
    } as any)
    await sparkClientManager.initialize(cfg('seed-a'))
    expect(sparkClientManager.isInitialized()).toBe(true)
    expect((sparkClientManager.getWallet() as { marker: string }).marker).toBe('WALLET_A')
  })
})
