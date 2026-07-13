/**
 * Liquid · testnet — live integration
 * -----------------------------------
 * Connects Alice and Bob to Liquid testnet (lwk + Esplora) and checks their
 * pre-funded L-BTC balances, asset list, and receive addresses. Includes an
 * opt-in Alice→Bob L-BTC send.
 *
 * NOTE: the lwk wasm is ~10 MB and the first scan hits Esplora, so timeouts are
 * generous. Skips unless ALICE_MNEMONIC + BOB_MNEMONIC are set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ALICE, BOB, LIQUID } from './config'
import { assertFunded, connectLiquid, safeDisconnect, spendableSend, withRetry } from './helpers'
import type { LiquidWdkAdapter } from '../../src/adapters/wdk/LiquidWdkAdapter'

describe.skipIf(!LIQUID.enabled)('Liquid testnet (Alice & Bob)', () => {
  let alice: LiquidWdkAdapter
  let bob: LiquidWdkAdapter

  beforeAll(async () => {
    // Connect serially, not in parallel: each connect does a gap-limit scan
    // (~40 esplora requests), and firing both at once doubles the burst that
    // trips the public esplora's rate limit (→ lwk's browser-only backoff sleep).
    alice = await connectLiquid(ALICE)
    bob = await connectLiquid(BOB)
  }, 180_000)

  afterAll(async () => {
    await Promise.all([safeDisconnect(alice), safeDisconnect(bob)])
  })

  it('connects both wallets on testnet', async () => {
    expect(alice.isConnected()).toBe(true)
    expect(bob.isConnected()).toBe(true)
    const info = await alice.getConnectionInfo()
    expect(info.protocol).toBe('LIQUID')
    // lwk reports the network as 'testnet' for the Liquid testnet.
    expect(info.network).toMatch(/testnet/i)
  }, 120_000)

  it('Alice is funded with L-BTC on testnet', async () => {
    // getBtcBalance re-scans; retry so a transient esplora rate-limit (which
    // trips lwk's browser-only sleep under Node) doesn't fail the read.
    const bal = await withRetry('Alice/Liquid balance', () => alice.getBtcBalance())
    assertFunded('Alice/Liquid', bal)
  }, 120_000)

  it('Bob is funded with L-BTC on testnet', async () => {
    const bal = await withRetry('Bob/Liquid balance', () => bob.getBtcBalance())
    assertFunded('Bob/Liquid', bal)
  }, 120_000)

  it('lists L-BTC first in the asset list', async () => {
    const assets = await withRetry('Alice/Liquid listAssets', () => alice.listAssets())
    expect(assets.length).toBeGreaterThan(0)
    expect(assets[0].ticker).toBe('L-BTC')
    expect(assets.every((a) => a.protocol === 'LIQUID')).toBe(true)
  }, 120_000)

  it('returns a confidential receive address for each wallet', async () => {
    const [a, b] = await Promise.all([alice.getReceiveAddress(), bob.getReceiveAddress()])
    expect(a.format).toBe('LIQUID_ADDRESS')
    expect(b.format).toBe('LIQUID_ADDRESS')
    expect(a.address.startsWith('tlq') || a.address.startsWith('lq')).toBe(true)
  }, 120_000)

  it('sends L-BTC Alice → Bob', async () => {
    const to = await bob.getReceiveAddress()
    const bal = await withRetry('Alice/Liquid balance (send)', () => alice.getBtcBalance())
    const amount = spendableSend(bal.total, 'Alice/Liquid')
    const res = await alice.sendPayment({ invoice: to.address, amount })
    expect(res.paymentHash).toBeTruthy()
    expect(res.status).toBe('pending')
  }, 180_000)
})
