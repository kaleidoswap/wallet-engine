/**
 * Arkade · mutinynet (signet) — live integration
 * ----------------------------------------------
 * Connects Alice and Bob to Arkade on Mutinynet and checks their pre-funded VTXO
 * balances and Ark + boarding addresses, plus an opt-in Alice→Bob transfer.
 * Skips unless ALICE_MNEMONIC + BOB_MNEMONIC are set.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ALICE, ARKADE, BOB } from './config'
import {
  assertFunded,
  connectArkade,
  liveSetup,
  safeDisconnect,
  sendOrSkip,
  skipWhenUnavailable,
  spendableSend,
} from './helpers'
import type { ArkadeWdkAdapter } from '../../src/adapters/wdk/ArkadeWdkAdapter'

describe.skipIf(!ARKADE.enabled)('Arkade mutinynet (Alice & Bob)', () => {
  let alice: ArkadeWdkAdapter
  let bob: ArkadeWdkAdapter

  let unavailable: string | undefined

  beforeAll(async () => {
    unavailable = await liveSetup('Arkade mutinynet', async () => {
      ;[alice, bob] = await Promise.all([connectArkade(ALICE), connectArkade(BOB)])
    })
  }, 180_000)

  // An unreachable endpoint skips this suite's tests one by one, so the
  // report still says how many the outage cost. See `liveSetup`.
  beforeEach((ctx) => skipWhenUnavailable(ctx, unavailable))

  afterAll(async () => {
    await Promise.all([safeDisconnect(alice), safeDisconnect(bob)])
  })

  it('connects both wallets on mutinynet (signet)', async () => {
    expect(alice.isConnected()).toBe(true)
    expect(bob.isConnected()).toBe(true)
    const info = await alice.getConnectionInfo()
    expect(info.protocol).toBe('ARKADE')
    expect(info.network).toBe('signet')
  }, 120_000)

  it('Alice is funded on Arkade', async () => {
    assertFunded('Alice/Arkade', await alice.getBtcBalance())
  }, 120_000)

  it('Bob is funded on Arkade', async () => {
    assertFunded('Bob/Arkade', await bob.getBtcBalance())
  }, 120_000)

  it('exposes an Ark address and an on-chain boarding address', async () => {
    const ark = await alice.getReceiveAddress()
    const boarding = await alice.getBoardingAddress()
    expect(ark.format).toBe('ARKADE_ADDRESS')
    expect(boarding.format).toBe('BTC_ADDRESS')
    expect(ark.address).not.toBe(boarding.address)
  }, 120_000)

  it('sends an Arkade transfer Alice → Bob', async (ctx) => {
    const to = await bob.getReceiveAddress()
    // Send from Alice's SPENDABLE VTXO balance (settled + preconfirmed). If her
    // funds are still in on-chain boarding (total > 0 but confirmed == 0) this fails
    // with an actionable message — boarding UTXOs must be onboarded first.
    const spendable = (await alice.getBtcBalance()).confirmed
    const amount = spendableSend(
      ctx,
      spendable,
      'Alice/Arkade (spendable VTXOs — onboard boarding funds if 0)',
    )
    const res = await sendOrSkip(ctx, 'Alice/Arkade', () =>
      alice.sendPayment({ invoice: to.address, amount }),
    )
    expect(res.status).toMatch(/pending|confirmed/)
  }, 180_000)
})
