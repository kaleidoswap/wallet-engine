/*
 * OPEN — NEEDS A PRODUCT DECISION, not a patch (run 2, REPORT-2.md).
 *
 * Still `describe.skip`ped, and deliberately so. The two RGB_L1 backends disagree
 * BY DESIGN on whether RGB-colored sats count toward the BTC balance:
 * `RgbLibWdkAdapter` reports vanilla only, `RgbLibWasmAdapter` sums, and
 * `convertBtcBalance` documents "don't show colored sats as spendable BTC".
 * `test/rgb-l1-wasm.test.ts` — pre-existing and NAMED for the behaviour ("adds
 * colored BTC sats to the spendable on-chain total") — pins the summing side with
 * exact figures, so this is a recorded decision for that adapter, not an oversight.
 * Run 1 wrote the fix, found that test, and reverted; run 2 confirms that reading.
 *
 * What remains is the cross-adapter DISAGREEMENT: someone must decide which side is
 * right and make the other match. These cases assert the vanilla-only side, so
 * removing the `.skip` is the second half of that decision.
 */
import { describe, expect, it } from 'vitest'
import { RgbLibWasmAdapter } from '../../src/adapters/wdk/RgbLibWasmAdapter'
import { RgbLibWdkAdapter } from '../../src/adapters/wdk/RgbLibWdkAdapter'

/**
 * Task G finding — RgbLibWasmAdapter.getBtcBalance() still sums RGB-COLORED
 * sats into the BTC balance. The sibling fix for audit finding C-F2
 * (commit f35b3c4, RgbAdapter) states in its own commit message:
 *
 *   "Not fixed here: `RgbLibWasmAdapter.getBtcBalance()` has the same defect
 *    and feeds it into the BTC asset entry. It is reported separately rather
 *    than folded into this commit."
 *
 * Colored sats sit under RGB asset allocations and cannot be spent as ordinary
 * BTC. `rgbBtcAsset` (RgbCore.ts) — which builds the BTC UnifiedAsset shown in
 * the wallet — is fed by this number, and a host uses it to bound a send or a
 * "max" button. RgbLibWdkAdapter (native rgb-lib WDK backend) already reads
 * the vanilla bucket only, so the two RGB_L1 adapters DISAGREE for identical
 * wallet state.
 */

const NODE_STATE = {
  vanilla: { settled: 5000, future: 5000, spendable: 5000 },
  colored: { settled: 2000, future: 2000, spendable: 2000 },
}

function wasmAdapter() {
  const a = new RgbLibWasmAdapter()
  Object.assign(a as any, {
    connected: true,
    account: { getBtcBalance: async () => NODE_STATE },
  })
  return a
}

function wdkAdapter() {
  const a = new RgbLibWdkAdapter()
  Object.assign(a as any, {
    connected: true,
    account: { registerWallet: async () => ({ address: 'bc1q…', btcBalance: NODE_STATE }) },
  })
  return a
}

describe.skip('G: RGB_L1 adapters must exclude colored sats from the BTC balance', () => {
  it('RgbLibWasmAdapter.getBtcBalance() reports vanilla only', async () => {
    const btc = await wasmAdapter().getBtcBalance()
    expect(btc.confirmed, 'colored sats are not spendable BTC').toBe(5000)
    expect(btc.total).toBe(5000)
  })

  it('the two RGB_L1 adapters agree for identical node state', async () => {
    const wasm = await wasmAdapter().getBtcBalance()
    const wdk = await wdkAdapter().getBtcBalance()
    expect(wasm.total).toBe(wdk.total)
  })
})
