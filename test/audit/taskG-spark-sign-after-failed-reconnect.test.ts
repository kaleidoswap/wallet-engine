/*
 * OPEN FINDING — reproduction, not yet fixed.
 *
 * `describe.skip` so the branch stays green: these assert the behaviour the
 * contract requires. Remove the `.skip` when the finding is fixed and each
 * becomes its regression test. See REPORT.md section 2.2.
 */
import { describe, expect, it, vi } from 'vitest'

/**
 * Task G finding — SparkAdapter can still SIGN while reporting not-connected.
 *
 * signPsbt / signMessage guard on `this.config?.mnemonic` ONLY
 * (SparkAdapter.ts:1121, 1134) — never on isConnected(). On a failed
 * RE-connect (wallet switch): sparkClientManager._doInitialize tears down the
 * old wallet FIRST (spark-client-manager.ts:153-156), then nulls it on failure
 * (line 208), so isConnected() → false; but the adapter's `this.config` still
 * holds the previous mnemonic from the earlier successful connect (line 126).
 * Net state: adapter reports disconnected yet signs messages/PSBTs with the
 * old wallet's keys. BaseWdkAdapter.ts:30-33 documents the intended invariant:
 * "a locked wallet must not be able to keep signing."
 */

const state = vi.hoisted(() => ({ wallet: null as any, failNext: false }))
vi.mock('../../src/lib/spark-client-manager', () => ({
  sparkClientManager: {
    initialize: async () => {
      if (state.failNext) {
        state.wallet = null // mirrors _doInitialize: teardown first, then null on failure
        throw new Error('gateway unreachable')
      }
      state.wallet = {}
    },
    disconnect: async () => { state.wallet = null },
    isInitialized: () => !!state.wallet,
    getWallet: () => state.wallet,
  },
}))

import { SparkAdapter } from '../../src/adapters/SparkAdapter'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('G: SparkAdapter must not sign while isConnected() is false', () => {
  it('a failed re-connect leaves the adapter disconnected AND unable to sign', async () => {
    const a = new SparkAdapter()
    await a.connect({ protocol: 'SPARK', mnemonic: MNEMONIC } as any)
    expect(a.isConnected()).toBe(true)

    // Wallet switch: the second connect fails after tearing down wallet A.
    state.failNext = true
    await expect(a.connect({ protocol: 'SPARK', mnemonic: MNEMONIC } as any)).rejects.toThrow()
    expect(a.isConnected(), 'wallet was torn down by the failed re-init').toBe(false)

    // The signing surface must be closed too — currently it still signs.
    await expect(a.signMessage('lnurl-auth challenge')).rejects.toThrow(/not connected|mnemonic/i)
    await expect(a.signPsbt('70736274ff')).rejects.toThrow(/not connected|mnemonic/i)
  })
})
