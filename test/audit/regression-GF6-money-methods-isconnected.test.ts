/*
 * Regression test for audit finding G-F6, residual half (REPORT-2.md §4.2).
 *
 * `RgbAdapter`'s fund-moving methods gated on `kaleidoClientManager.hasNode()` —
 * "is a node URL configured on the module singleton" — rather than on
 * `this.isConnected()`, which additionally requires that THIS adapter completed
 * a handshake and has not been disconnected.
 *
 * Commit 321ac98 closed the route that made it exploitable at the time: a
 * `connect()` that threw after `kaleidoClientManager.initialize()` had already
 * run used to leave the manager holding the node URL, so the host hid the send UI
 * while any code path still holding the adapter could spend. That fix reset the
 * manager in connect()'s catch. It left the guards divergent, which its own
 * message recorded: "the money methods still gate on hasNode() rather than
 * isConnected(), so the two remain divergent for any OTHER route that could
 * initialise the manager without a successful connect."
 *
 * `kaleidoClientManager` is an exported module singleton with a public
 * `initialize()`. Anything that calls it — a host, a sibling module, a future
 * refactor — reopens the gap. The four money paths now check both.
 *
 * The later residual pass applies the same guard to the remaining methods.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'

afterEach(() => vi.restoreAllMocks())

/** The four fund-moving methods and a minimal call for each. */
const MONEY_PATHS: ReadonlyArray<[string, (a: RgbAdapter) => Promise<unknown>]> = [
  ['sendPayment', (a) => a.sendPayment({ invoice: 'lnbc1something' } as never)],
  ['payKeysend', (a) => a.payKeysend({ pubkey: 'a'.repeat(66), amount: 1000 } as never)],
  ['sendAsset', (a) => a.sendAsset({ asset_id: 'rgb:x', amount: 1, recipient_id: 'r' })],
  ['sendBtcOnchain', (a) => a.sendBtcOnchain({ address: 'bc1qexample', amount: 1000 })],
]

/**
 * The exact divergence: the module singleton is initialised (so `hasNode()` is
 * true) but this adapter never completed a connect. Reproduced by driving the
 * singleton's public surface, which is what any other caller would do.
 */
function nodeConfiguredButAdapterNotConnected(): RgbAdapter {
  vi.spyOn(kaleidoClientManager, 'hasNode').mockReturnValue(true)
  vi.spyOn(kaleidoClientManager, 'isInitialized').mockReturnValue(true)
  vi.spyOn(kaleidoClientManager, 'getClient').mockReturnValue({
    rln: {
      sendPayment: async () => ({ payment_hash: 'ph', status: 'Succeeded' }),
      keysend: async () => ({ payment_hash: 'ph', status: 'Succeeded' }),
      sendAsset: async () => ({ txid: 'tx' }),
      sendBtc: async () => ({ txid: 'tx' }),
      estimateFee: async () => ({ fee_rate: 10 }),
      decodeLNInvoice: async () => ({ amt_msat: 1000 }),
    },
  } as never)
  // `connected` is left false — no handshake ever completed for this adapter.
  const a = new RgbAdapter()
  Object.assign(a as never, {
    config: { protocol: 'RGB_LN', network: 'regtest', nodeUrl: 'http://node:3001' },
  })
  return a
}

describe('G-F6: a disconnected RgbAdapter must not be able to spend', () => {
  for (const [name, call] of MONEY_PATHS) {
    it(`${name} refuses when the node is configured but the adapter is not connected`, async () => {
      const a = nodeConfiguredButAdapterNotConnected()
      expect(a.isConnected(), 'precondition: the adapter is NOT connected').toBe(false)
      await expect(call(a)).rejects.toThrow(/not connected/i)
    })
  }

  for (const [name, call] of MONEY_PATHS) {
    it(`${name} refuses after disconnect(), even with the manager still initialized`, async () => {
      const a = nodeConfiguredButAdapterNotConnected()
      Object.assign(a as never, { connected: true })
      expect(a.isConnected()).toBe(true)

      // Simulate a host that tears the adapter down while something else keeps
      // the singleton alive — the divergence this finding is about.
      Object.assign(a as never, { connected: false })
      await expect(call(a)).rejects.toThrow(/not connected/i)
    })
  }

  it('a properly connected adapter still spends — this is a guard, not a block', async () => {
    const a = nodeConfiguredButAdapterNotConnected()
    Object.assign(a as never, { connected: true })
    expect(a.isConnected()).toBe(true)
    await expect(a.sendBtcOnchain({ address: 'bc1qexample', amount: 1000 })).resolves.toBeTruthy()
  })

  it('the node-not-configured guard is kept as well, and still reports its own code', async () => {
    // Both checks run: `isConnected()` first (so a disconnected adapter reports
    // NOT_CONNECTED), then `hasNode()`. A connected adapter with no node URL
    // still gets NODE_NOT_CONFIGURED rather than a confusing "not connected".
    const a = new RgbAdapter()
    vi.spyOn(kaleidoClientManager, 'isInitialized').mockReturnValue(true)
    vi.spyOn(kaleidoClientManager, 'hasNode').mockReturnValue(false)
    Object.assign(a as never, { connected: true, config: { protocol: 'RGB_LN' } })
    expect(a.isConnected()).toBe(true)
    await expect(
      a.sendBtcOnchain({ address: 'bc1qexample', amount: 1000 }),
    ).rejects.toThrow(/node not configured/i)
  })
})
