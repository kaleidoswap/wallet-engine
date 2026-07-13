/**
 * RGB-L1 (rgb-lib) · mutinynet (signet) — live integration
 * --------------------------------------------------------
 * Connects Alice and Bob to a LOCAL rgb-lib wallet (RgbLibWdkAdapter) on
 * Mutinynet. rgb-lib holds keys in-process and persists SQLite state under a
 * per-wallet dataDir, so Alice and Bob never share state.
 *
 * Checks their pre-funded on-chain (vanilla) BTC balance, RGB asset list, and
 * BTC receive address. RGB asset *transfers* require colorable UTXOs and a
 * consignment exchange over the proxy, so they stay behind RUN_SEND_TESTS.
 *
 * Skips unless ALICE_MNEMONIC + BOB_MNEMONIC are set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ALICE, BOB, RGB_L1 } from './config'
import { assertFunded, connectRgbL1, safeDisconnect } from './helpers'
import type { RgbLibWdkAdapter } from '../../src/adapters/wdk/RgbLibWdkAdapter'

describe.skipIf(!RGB_L1.enabled)('RGB-L1 rgb-lib mutinynet (Alice & Bob)', () => {
  let alice: RgbLibWdkAdapter
  let bob: RgbLibWdkAdapter

  beforeAll(async () => {
    // rgb-lib registers each wallet with the indexer on connect — do it serially
    // so two cold SQLite/indexer registrations don't contend.
    alice = await connectRgbL1(ALICE)
    bob = await connectRgbL1(BOB)
  }, 240_000)

  afterAll(async () => {
    await Promise.all([safeDisconnect(alice), safeDisconnect(bob)])
  })

  it('connects both wallets on mutinynet (signet)', async () => {
    expect(alice.isConnected()).toBe(true)
    expect(bob.isConnected()).toBe(true)
    const info = await alice.getConnectionInfo()
    expect(info.protocol).toBe('RGB_L1')
    expect(info.network).toBe('signet')
  }, 120_000)

  it('Alice has a funded vanilla (on-chain) BTC balance', async () => {
    await alice.refreshBalances()
    assertFunded('Alice/RGB-L1 vanilla BTC', await alice.getBtcBalance())
  }, 180_000)

  it('Bob has a funded vanilla (on-chain) BTC balance', async () => {
    await bob.refreshBalances()
    assertFunded('Bob/RGB-L1 vanilla BTC', await bob.getBtcBalance())
  }, 180_000)

  it('lists RGB assets (may be empty on a freshly-funded wallet)', async () => {
    const assets = await alice.listAssets()
    expect(Array.isArray(assets)).toBe(true)
    expect(assets.every((a) => a.protocol === 'RGB_L1')).toBe(true)
  }, 120_000)

  it('returns a BTC on-chain receive address', async () => {
    const addr = await alice.getReceiveAddress()
    expect(addr.format).toBe('BTC_ADDRESS')
    expect(addr.address.length).toBeGreaterThan(0)
  }, 120_000)

  it('ensures colorable UTXOs exist for receiving RGB', async () => {
    // `upTo` = "make sure at least N colorable UTXOs exist". If the wallet
    // already has them, rgb-lib throws AllocationsAlreadyAvailable — that's the
    // postcondition already met, not a failure, so treat it as success.
    try {
      const res = await alice.createRgbUtxos!({ num: 1, upTo: true })
      expect(res.success).toBe(true)
    } catch (err) {
      expect(String(err)).toMatch(/AllocationsAlreadyAvailable/)
    }
  }, 180_000)
})
