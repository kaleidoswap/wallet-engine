/**
 * RGB-L1 (rgb-lib) · mutinynet (signet) — live integration
 * --------------------------------------------------------
 * Connects Alice and Bob to a LOCAL rgb-lib wallet on Mutinynet. rgb-lib holds keys
 * in-process and persists SQLite state under a per-wallet dataDir, so the two never
 * share state.
 *
 * Checks pre-funded vanilla BTC balance, RGB asset list and BTC receive address,
 * plus opt-in NIA issuance and an asset transfer — the two paths that were
 * described in this header for months while no test existed for either (#88).
 * Skips unless ALICE_MNEMONIC + BOB_MNEMONIC are set.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ALICE, BOB, RGB_L1, RUN_SEND_TESTS } from './config'
import {
  assertFunded,
  connectRgbL1,
  describeError,
  liveSetup,
  returnFunds,
  safeDisconnect,
  sendOrSkip,
  skipWhenUnavailable,
} from './helpers'
import type { UnifiedAsset } from '../../src/types/base'
import type { RgbLibWdkAdapter } from '../../src/adapters/wdk/RgbLibWdkAdapter'

describe.skipIf(!RGB_L1.enabled)('RGB-L1 rgb-lib mutinynet (Alice & Bob)', () => {
  let alice: RgbLibWdkAdapter
  let bob: RgbLibWdkAdapter

  let unavailable: string | undefined

  /** The NIA asset these tests move, and which wallet currently holds it. */
  let asset: UnifiedAsset | undefined
  let holder: 'alice' | 'bob' | undefined
  /** Amount the transfer test moved, for teardown to send back. */
  let sentAmount = 0

  beforeAll(async () => {
    unavailable = await liveSetup('RGB-L1 mutinynet', async () => {
      // rgb-lib registers each wallet with the indexer on connect — do it serially
      // so two cold SQLite/indexer registrations don't contend.
      alice = await connectRgbL1(ALICE)
      bob = await connectRgbL1(BOB)
    })
  }, 240_000)

  // An unreachable endpoint skips this suite's tests one by one, so the
  // report still says how many the outage cost. See `liveSetup`.
  beforeEach((ctx) => skipWhenUnavailable(ctx, unavailable))

  afterAll(async () => {
    if (asset && sentAmount && holder) {
      // Send it back, so the suite does not migrate the asset one run at a time
      // and force a fresh issuance once the sender runs out. Best-effort by
      // design: an RGB transfer the recipient cannot yet spend (the incoming
      // allocation is unconfirmed) is a fact about timing, not a regression —
      // and the next run picks whichever wallet holds it anyway.
      const back = holder === 'alice' ? bob : alice
      const to = holder === 'alice' ? alice : bob
      await returnFunds(`RGB-L1 ${holder === 'alice' ? 'Bob → Alice' : 'Alice → Bob'}`, async () => {
        // Same constraint as the outbound leg: bind the invoice to the asset
        // only when this wallet already knows it.
        const knows = (await to.listAssets()).some((a) => a.id === asset!.id)
        const invoice: any = await to.createRgbInvoice!(
          knows ? { assetId: asset!.id, amount: sentAmount } : { amount: sentAmount },
        )
        return back.sendAsset!({ token: asset!.id, recipient: invoice?.invoice ?? invoice, amount: sentAmount })
      })
    }
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

  /**
   * Reuse a NIA asset either wallet already holds, and issue one only when
   * neither does.
   *
   * Issuing every run would be the obvious thing and the wrong one: each
   * issuance consumes a colorable UTXO and an on-chain fee, and this suite runs
   * on every PR touching `src/**`, so it would mint assets until the wallet ran
   * out of UTXOs to colour. Reuse keeps the transfer test supplied without that.
   *
   * `RGB_FORCE_ISSUANCE=1` issues regardless, for a run whose purpose is to
   * exercise issuance itself.
   */
  it.skipIf(!RUN_SEND_TESTS)('holds a NIA asset, issuing one if neither wallet does', async (ctx) => {
    const niaWithBalance = async (w: RgbLibWdkAdapter) =>
      (await w.listAssets()).find((a) => a.id !== 'BTC' && a.balance.available > 0)

    const force = /^(1|true|yes)$/i.test(process.env.RGB_FORCE_ISSUANCE?.trim() ?? '')
    if (!force) {
      const mine = await niaWithBalance(alice)
      if (mine) {
        asset = mine
        holder = 'alice'
      } else {
        const theirs = await niaWithBalance(bob)
        if (theirs) {
          asset = theirs
          holder = 'bob'
        }
      }
    }

    if (!asset) {
      // Issuance needs a colorable UTXO; the previous test guarantees one.
      const ticker = `KS${Date.now().toString(36).slice(-4).toUpperCase()}`
      try {
        asset = await alice.issueAssetNia!({
          ticker,
          name: `KaleidoSwap integration ${ticker}`,
          precision: 0,
          amounts: [1_000_000],
        })
      } catch (error) {
        // An outage or a wallet with nothing to colour is not a broken adapter.
        const reason = `Alice/RGB-L1 issuance: ${describeError(error)}`
        console.warn(`⚠ SKIPPED — ${reason}`)
        ctx.skip(reason)
        return
      }
      holder = 'alice'
      console.log(`[RGB_L1] issued ${asset.id} (${ticker})`)
    } else {
      console.log(`[RGB_L1] reusing ${asset.id} held by ${holder}`)
    }

    expect(asset.id).toBeTruthy()
    expect(asset.id).not.toBe('BTC')
    expect(asset.protocol).toBe('RGB_L1')
    expect(asset.balance.available).toBeGreaterThan(0)

    // The issuance is only real if the wallet can list it back.
    const listed = await (holder === 'alice' ? alice : bob).listAssets()
    expect(listed.map((a) => a.id)).toContain(asset.id)
  }, 300_000)

  /**
   * Move the asset between the wallets: a blinded receive on one side, a
   * consignment through the RGB proxy, a witness transaction on the other.
   *
   * Direction follows whoever holds it, so the suite stays runnable whichever
   * way the last run left the balance — and does not need a fresh issuance to
   * have something to send.
   *
   * What this asserts is the send: an RGB transfer built, signed and broadcast,
   * with a txid to reconcile. Arrival is reported, not asserted — the recipient
   * cannot see a spendable allocation until the transfer confirms and both
   * wallets refresh, and a test that waited on mutinynet confirmations would be
   * a flake generator rather than a check.
   */
  it.skipIf(!RUN_SEND_TESTS)('transfers the asset between Alice and Bob', async (ctx) => {
    if (!asset || !holder) ctx.skip('no NIA asset available to transfer')

    const from = holder === 'alice' ? alice : bob
    const to = holder === 'alice' ? bob : alice
    const label = holder === 'alice' ? 'Alice → Bob' : 'Bob → Alice'
    const amount = 10

    // The recipient needs a colorable UTXO of its own to receive into.
    try {
      await to.createRgbUtxos!({ num: 1, upTo: true })
    } catch (err) {
      expect(String(err)).toMatch(/AllocationsAlreadyAvailable/)
    }

    // Name the asset in the invoice only when the recipient already knows it.
    // rgb-lib answers `AssetNotFound` for an asset id its wallet has never seen,
    // and a first-time recipient by definition has not: the asset reaches it
    // through the sender's consignment, not through the invoice. So the first
    // transfer asks for a bare blinded UTXO, and later ones can bind to the
    // asset. (This is what the first CI run of this test taught us.)
    const recipientKnowsAsset = (await to.listAssets()).some((a) => a.id === asset!.id)
    const invoice: any = await to.createRgbInvoice!(
      recipientKnowsAsset ? { assetId: asset!.id, amount } : { amount },
    )
    const recipient: string = invoice?.invoice ?? invoice
    expect(typeof recipient).toBe('string')
    expect(recipient.startsWith('rgb:')).toBe(true)

    const before = (await to.getAssetBalance!(asset!.id)).total

    const res: any = await sendOrSkip(ctx, `RGB-L1 ${label}`, () =>
      from.sendAsset!({ token: asset!.id, recipient, amount }),
    )
    const txid = res?.hash ?? res?.txid ?? ''
    expect(txid).toBeTruthy()
    expect(txid).not.toBe('unknown')
    sentAmount = amount

    const after = (await to.getAssetBalance!(asset!.id)).total
    console.log(`[RGB_L1] ${label} ${amount} of ${asset!.id} — txid ${txid}, recipient total ${before} → ${after}`)
  }, 300_000)
})
