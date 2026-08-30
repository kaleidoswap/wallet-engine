import { afterEach, describe, expect, it } from 'vitest'
import { SparkWdkAdapter } from '../../src/adapters/wdk/SparkWdkAdapter'
import { sparkClientManager } from '../../src/lib/spark-client-manager'

/**
 * Audit finding A5 — `SparkWdkAdapter.connect()` adopts its raw SparkWallet into
 * the module-level `sparkClientManager` singleton (SparkWdkAdapter.ts:174) but
 * did not override `disconnect()`. The inherited `BaseWdkAdapter.disconnect()`
 * clears only the adapter's own fields — whose doc comment says "a locked wallet
 * must not be able to keep signing" — while the singleton kept handing out a
 * live, signing-capable wallet.
 */
afterEach(() => sparkClientManager.reset())

function connectedAdapter(rawWallet: object): SparkWdkAdapter {
  const a = new SparkWdkAdapter()
  Object.assign(a as any, {
    manager: { dispose: async () => {} },
    account: { dispose: async () => {}, _wallet: rawWallet },
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    connected: true,
  })
  sparkClientManager.adoptExternalWallet(rawWallet, 'regtest')
  return a
}

describe('A5: tearing down the WDK Spark adapter must release the adopted wallet', () => {
  it('the singleton no longer hands out a signing-capable wallet after disconnect()', async () => {
    let spent = false
    const rawWallet = {
      transferTokens: async () => { spent = true; return 'txid' },
      getSparkAddress: async () => 'spark1test',
      cleanupConnections: async () => {},
    }
    const adapter = connectedAdapter(rawWallet)
    expect(sparkClientManager.isInitialized()).toBe(true)

    await adapter.disconnect()

    expect(adapter.isConnected()).toBe(false)
    expect(sparkClientManager.isInitialized(), 'adopted wallet must be released').toBe(false)
    expect(() => sparkClientManager.getWallet()).toThrow()
    expect(spent).toBe(false)
  })

  it('disconnect does not steal a wallet the singleton got from somewhere else', async () => {
    const mine = { cleanupConnections: async () => {} }
    const someoneElses = { cleanupConnections: async () => {} }
    const adapter = connectedAdapter(mine)
    // A different owner re-adopts before this adapter tears down.
    sparkClientManager.adoptExternalWallet(someoneElses, 'regtest')

    await adapter.disconnect()

    expect(sparkClientManager.isInitialized(), 'the other owner keeps its wallet').toBe(true)
    expect(sparkClientManager.getWallet()).toBe(someoneElses)
  })

  it('disconnect on an adapter that never adopted is a no-op for the singleton', async () => {
    const other = { cleanupConnections: async () => {} }
    sparkClientManager.adoptExternalWallet(other, 'regtest')
    const a = new SparkWdkAdapter()
    Object.assign(a as any, { manager: null, account: null, connected: false })
    await a.disconnect()
    expect(sparkClientManager.isInitialized()).toBe(true)
  })
})
