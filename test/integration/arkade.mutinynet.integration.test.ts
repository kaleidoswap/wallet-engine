/**
 * Arkade · mutinynet (signet) — live integration
 * ----------------------------------------------
 * Connects Alice and Bob to Arkade on Mutinynet (a custom signet) and checks
 * their pre-funded VTXO balances, Ark + boarding addresses. Includes an opt-in
 * Alice→Bob Ark transfer.
 *
 * Skips unless ALICE_MNEMONIC + BOB_MNEMONIC are set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ALICE, ARKADE, BOB, RUN_SEND_TESTS } from './config'
import { assertFunded, connectArkade, safeDisconnect } from './helpers'
import type { ArkadeWdkAdapter } from '../../src/adapters/wdk/ArkadeWdkAdapter'

describe.skipIf(!ARKADE.enabled)('Arkade mutinynet (Alice & Bob)', () => {
  let alice: ArkadeWdkAdapter
  let bob: ArkadeWdkAdapter

  beforeAll(async () => {
    ;[alice, bob] = await Promise.all([connectArkade(ALICE), connectArkade(BOB)])
  }, 180_000)

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

  it.skipIf(!RUN_SEND_TESTS)('sends an Arkade transfer Alice → Bob', async () => {
    const to = await bob.getReceiveAddress()
    const res = await alice.sendPayment({ invoice: to.address, amount: 1000 })
    expect(res.status).toMatch(/pending|confirmed/)
  }, 180_000)
})
