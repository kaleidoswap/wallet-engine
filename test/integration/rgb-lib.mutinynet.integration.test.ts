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
  ensureColorableSlots,
  liveSetup,
  returnFunds,
  safeDisconnect,
  sendOrSkip,
  skipWhenUnavailable,
  waitForSpendableAsset,
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
      // Send it back so the asset does not migrate one run at a time.
      // Best-effort: an unconfirmed incoming allocation cannot be spent yet.
      const back = holder === 'alice' ? bob : alice
      const to = holder === 'alice' ? alice : bob
      await returnFunds(`RGB-L1 ${holder === 'alice' ? 'Bob → Alice' : 'Alice → Bob'}`, async () => {
        // Same constraint as the outbound leg.
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

  /**
   * Prepare colorable UTXOs on both wallets, early on purpose: `createRgbUtxos`
   * broadcasts a transaction whose outputs are unusable until it confirms. Two
   * slots each, since either wallet may end up the sender (asset + change).
   * Asserts no count — mutinynet decides when a transaction confirms.
   */
  it('prepares colorable UTXOs on both wallets', async () => {
    const [aliceSlots, bobSlots] = await Promise.all([
      ensureColorableSlots(alice, 2, 'alice', { timeoutMs: 60_000 }),
      ensureColorableSlots(bob, 2, 'bob', { timeoutMs: 60_000 }),
    ])
    expect(aliceSlots).toBeGreaterThanOrEqual(0)
    expect(bobSlots).toBeGreaterThanOrEqual(0)
  }, 240_000)

  /**
   * Reuse a NIA asset either wallet holds, issuing only when neither does —
   * each issuance costs a colorable UTXO and a fee, and this suite runs on
   * every PR. `RGB_FORCE_ISSUANCE=1` issues regardless.
   */
  it.skipIf(!RUN_SEND_TESTS)('holds a NIA asset, issuing one if neither wallet does', async (ctx) => {
    /**
     * Any NIA asset this wallet HOLDS — `total`, not `available`: after a
     * transfer the change is unconfirmed, so spendable reads 0 while the wallet
     * still owns the asset. Spendability is the transfer test's problem.
     */
    const niaHeld = async (w: RgbLibWdkAdapter) => {
      const assets = (await w.listAssets()).filter((a) => a.id !== 'BTC')
      console.log(
        `[RGB_L1] ${w === alice ? 'alice' : 'bob'} holds: ${
          assets.map((a) => `${a.id}(total=${a.balance.total},avail=${a.balance.available})`).join(' ') || 'nothing'
        }`,
      )
      return assets.find((a) => a.balance.total > 0)
    }

    const force = /^(1|true|yes)$/i.test(process.env.RGB_FORCE_ISSUANCE?.trim() ?? '')
    if (!force) {
      const mine = await niaHeld(alice)
      if (mine) {
        asset = mine
        holder = 'alice'
      } else {
        const theirs = await niaHeld(bob)
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
    expect(asset.balance.total).toBeGreaterThan(0)

    // The issuance is only real if the wallet can list it back.
    const listed = await (holder === 'alice' ? alice : bob).listAssets()
    expect(listed.map((a) => a.id)).toContain(asset.id)
  }, 300_000)

  /**
   * Move the asset between the wallets, once per receive mode. They differ in
   * who supplies the output: **blinded** needs a free slot on the recipient,
   * **witness** needs none because the sender creates it — which makes witness
   * the mode that works for a wallet that has never held RGB.
   *
   * Direction follows whoever holds the asset. Asserts the send, not arrival:
   * an allocation is not spendable until the transfer confirms, and waiting on
   * that would generate flakes rather than signal.
   */
  for (const mode of ['blinded', 'witness'] as const) {
    it.skipIf(!RUN_SEND_TESTS)(`transfers the asset by ${mode} receive`, async (ctx) => {
      if (!asset || !holder) ctx.skip('no NIA asset available to transfer')

      const from = holder === 'alice' ? alice : bob
      const to = holder === 'alice' ? bob : alice
      const label = `${holder === 'alice' ? 'Alice → Bob' : 'Bob → Alice'} (${mode})`
      const amount = 10

      // Wait rather than skip: the mode that runs second would otherwise always
      // find 0 spendable, so it would never execute. The wait also covers
      // spending the change from a previous transfer.
      let spendable = (await from.getAssetBalance!(asset!.id)).available
      if (spendable < amount) {
        // `to` as well: the change settles only once the recipient accepts.
        spendable = await waitForSpendableAsset(from, asset!.id, amount, `${holder}/${mode}`, {
          refreshAlso: [to],
        })
      }
      if (spendable < amount) {
        const reason = `${holder}/RGB-L1 holds ${asset!.id} but only ${spendable} is spendable (needs ${amount}) — the last transfer's change did not settle in time`
        console.warn(`⚠ SKIPPED — ${reason}`)
        ctx.skip(reason)
        return
      }

      // The sender always needs a slot for its change; only a blinded recipient
      // needs one to receive into.
      const senderSlots = await ensureColorableSlots(from, 1, `${holder}/sender`)
      if (senderSlots < 1) {
        const reason = `${holder}/RGB-L1 has no free colorable UTXO for the change output — createRgbUtxos has not confirmed yet`
        console.warn(`⚠ SKIPPED — ${reason}`)
        ctx.skip(reason)
        return
      }
      if (mode === 'blinded') {
        const recipientSlots = await ensureColorableSlots(to, 1, `${holder === 'alice' ? 'bob' : 'alice'}/recipient`)
        if (recipientSlots < 1) {
          const reason = `the ${mode} recipient has no free colorable UTXO to receive into — createRgbUtxos has not confirmed yet`
          console.warn(`⚠ SKIPPED — ${reason}`)
          ctx.skip(reason)
          return
        }
      }

      // Name the asset only when the recipient knows it: rgb-lib answers
      // `AssetNotFound` otherwise, since the asset arrives via the consignment.
      const recipientKnowsAsset = (await to.listAssets()).some((a) => a.id === asset!.id)
      const invoice: any = await to.createRgbInvoice!({
        ...(recipientKnowsAsset ? { assetId: asset!.id } : {}),
        amount,
        // Nothing here needs an invoice to outlive its own test.
        durationSeconds: 120,
        ...(mode === 'witness' ? { witness: true } : {}),
      })
      const recipient: string = invoice?.invoice ?? invoice
      expect(typeof recipient).toBe('string')
      expect(recipient.startsWith('rgb:')).toBe(true)

      const before = (await to.getAssetBalance!(asset!.id)).total

      // A witness recipient has no outpoint: the sender creates the output and
      // must size it, or rgb-lib refuses with `InvalidRecipientData`. 1000 sat
      // matches rgb-lib's own colorable UTXOs and clears dust.
      const res: any = await sendOrSkip(ctx, `RGB-L1 ${label}`, () =>
        from.sendAsset!({
          token: asset!.id,
          recipient,
          amount,
          ...(mode === 'witness' ? { witnessData: { amountSat: 1000 } } : {}),
        }),
      )
      const txid = res?.hash ?? res?.txid ?? ''
      expect(txid).toBeTruthy()
      expect(txid).not.toBe('unknown')
      sentAmount = amount

      const after = (await to.getAssetBalance!(asset!.id)).total
      console.log(`[RGB_L1] ${label} ${amount} of ${asset!.id} — txid ${txid}, recipient total ${before} → ${after}`)
      // Room for the settle wait above (180s) plus two live sends.
    }, 420_000)
  }
})
