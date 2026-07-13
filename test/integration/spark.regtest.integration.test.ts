/**
 * Spark · regtest — live integration
 * ----------------------------------
 * Connects Alice and Bob to Spark regtest and exercises the read paths against
 * their pre-funded balances, plus an opt-in Alice→Bob native transfer.
 *
 * Skips entirely unless ALICE_MNEMONIC + BOB_MNEMONIC are set. Run with:
 *   npm run test:integration
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ALICE, BOB, SPARK } from './config'
import { assertFunded, connectSpark, safeDisconnect, spendableSend } from './helpers'
import type { SparkWdkAdapter } from '../../src/adapters/wdk/SparkWdkAdapter'

describe.skipIf(!SPARK.enabled)('Spark regtest (Alice & Bob)', () => {
  let alice: SparkWdkAdapter
  let bob: SparkWdkAdapter

  beforeAll(async () => {
    ;[alice, bob] = await Promise.all([connectSpark(ALICE), connectSpark(BOB)])
  }, 120_000)

  afterAll(async () => {
    await Promise.all([safeDisconnect(alice), safeDisconnect(bob)])
  })

  it('connects both wallets on regtest', async () => {
    expect(alice.isConnected()).toBe(true)
    expect(bob.isConnected()).toBe(true)
    const info = await alice.getConnectionInfo()
    expect(info.protocol).toBe('SPARK')
    expect(info.network).toBe('regtest')
  })

  it('Alice is funded on regtest', async () => {
    assertFunded('Alice/Spark', await alice.getBtcBalance())
  })

  it('Bob is funded on regtest', async () => {
    assertFunded('Bob/Spark', await bob.getBtcBalance())
  })

  it('exposes a static Spark receive address for each wallet', async () => {
    const [a, b] = await Promise.all([
      alice.getReceiveAddress('SPARK'),
      bob.getReceiveAddress('SPARK'),
    ])
    expect(a.format).toBe('SPARK_ADDRESS')
    expect(b.format).toBe('SPARK_ADDRESS')
    expect(a.address).not.toBe(b.address) // distinct wallets
  })

  it('sends a native Spark transfer Alice → Bob', async () => {
    const to = await bob.getReceiveAddress('SPARK')
    const before = (await bob.getBtcBalance()).total
    // Size the send to Alice's actual balance so this validates the transfer
    // MECHANISM without assuming a specific funded amount (these are shared,
    // slowly-draining test wallets). Fails loudly if Alice is genuinely empty.
    const amount = spendableSend((await alice.getBtcBalance()).total, 'Alice/Spark')
    const res = await alice.sendPayment({ invoice: to.address, amount })
    expect(res.status).toMatch(/pending|confirmed/)
    // Spark transfers settle fast; poll Bob's balance briefly.
    let after = before
    for (let i = 0; i < 10 && after <= before; i++) {
      await new Promise((r) => setTimeout(r, 1500))
      after = (await bob.getBtcBalance()).total
    }
    expect(after).toBeGreaterThan(before)
  }, 120_000)
})
