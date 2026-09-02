/**
 * AUDIT N4 (run 2, Phase 3 concurrency) — `SparkClientManager.getReadonlyClient()`
 * has no teardown/identity guard, so the A2 resurrection shape survives in the
 * same file that was fixed for it.
 *
 * `getReadonlyClient()` reads the mnemonic from `this.config`, awaits
 * `SparkReadonlyClient.createWithMasterKey(...)`, then assigns
 * `this.readonlyClient = client` unconditionally. `disconnect()`/`reset()` null
 * the field but cannot cancel the pending build, and the generation counter
 * added by 7b95f0a is never consulted here. So:
 *
 *  a) a `disconnect()` landing mid-build leaves a live client, keyed to the
 *     wiped wallet's master key, cached on the singleton — and the `if
 *     (this.readonlyClient) return` fast path serves it afterwards, bypassing
 *     the `if (!this.config?.mnemonic) throw` gate entirely;
 *  b) on a wallet switch, wallet B's session is handed the client built from
 *     wallet A's master key.
 *
 * Reachable from `SparkAdapter.listTransactions({ fromTimestamp })`
 * (src/adapters/SparkAdapter.ts:308).
 *
 * Deterministic: the SDK's readonly-client factory is mocked with deferreds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const roState = {
  pending: [] as Array<{ seed: string; resolve: (client: unknown) => void }>,
}

vi.mock('@buildonspark/spark-sdk', () => {
  const SparkReadonlyClient = {
    createWithMasterKey: (_opts: unknown, mnemonicOrSeed: string) =>
      new Promise((resolve) => {
        roState.pending.push({
          seed: mnemonicOrSeed,
          resolve: () => resolve({ builtFrom: mnemonicOrSeed }),
        })
      }),
  }
  const SparkWallet = { initialize: async () => ({ wallet: {} }) }
  return { SparkWallet, SparkReadonlyClient }
})

import { sparkClientManager } from '../../src/lib/spark-client-manager'
import type { SparkConfig } from '../../src/types/spark'

const SEED_A = 'seed-a-1111111111111111111111111111111111111111111111111111111111'
const SEED_B = 'seed-b-2222222222222222222222222222222222222222222222222222222222'

function cfg(mnemonic: string): SparkConfig {
  return { protocol: 'SPARK', network: 'regtest', mnemonic } as SparkConfig
}
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
const fakeWallet = (marker: string) => ({ marker, cleanupConnections: async () => {} })

async function connect(seed: string, marker: string): Promise<void> {
  const d = deferred<{ wallet: object }>()
  sparkClientManager.setSdkFactory({ initializeWallet: () => d.promise } as never)
  const init = sparkClientManager.initialize(cfg(seed))
  d.resolve({ wallet: fakeWallet(marker) })
  await init
}

afterEach(() => {
  sparkClientManager.reset()
  roState.pending.length = 0
})

describe('N4: SparkClientManager readonly client vs teardown', () => {
  it('a) a disconnect() mid-build must not leave a live readonly client cached', async () => {
    await connect(SEED_A, 'WALLET_A')

    const p = sparkClientManager.getReadonlyClient()
    await vi.waitFor(() => expect(roState.pending).toHaveLength(1))

    // Host locks the wallet while the readonly client is still being built.
    await sparkClientManager.disconnect()
    expect(sparkClientManager.isInitialized()).toBe(false)

    roState.pending[0].resolve(null)
    await p.catch(() => {})

    // The wallet is torn down and the config wiped — there is no credential from
    // which a readonly client may be served.
    await expect(sparkClientManager.getReadonlyClient()).rejects.toThrow()
  })

  it('b) a wallet switch mid-build must not serve wallet A\'s readonly client to B', async () => {
    await connect(SEED_A, 'WALLET_A')

    const pA = sparkClientManager.getReadonlyClient()
    await vi.waitFor(() => expect(roState.pending).toHaveLength(1))
    expect(roState.pending[0].seed).toBe(SEED_A)

    // Wallet switch while A's readonly build is pending.
    await connect(SEED_B, 'WALLET_B')

    // A's build lands after the switch.
    roState.pending[0].resolve(null)
    await pA.catch(() => {})

    // Wallet B's session must get a client built from B's key, never A's. The
    // manager must start a FRESH build rather than serving A's cached client.
    const pB = sparkClientManager.getReadonlyClient()
    // getReadonlyClient() reaches createWithMasterKey synchronously, so a fresh
    // build for B is already queued here if one was started at all.
    const latest = roState.pending[roState.pending.length - 1]
    if (roState.pending.length > 1) latest.resolve(null)
    const clientB = (await pB) as unknown as { builtFrom: string }
    expect(clientB.builtFrom).toBe(SEED_B)
  })
})
