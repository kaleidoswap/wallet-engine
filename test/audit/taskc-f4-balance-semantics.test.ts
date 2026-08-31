/*
 * OPEN FINDING — reproduction, not yet fixed.
 *
 * `describe.skip` so the branch stays green: these assert the behaviour the
 * code SHOULD have. Remove the `.skip` when the finding is fixed and they
 * become its regression test. See REPORT.md for the finding this belongs to.
 */
import { describe, it, expect } from 'vitest'
import { convertSdkBalance, convertNodeBalance } from '../../src/lib/rgb-converters'
import { rgbAssetBalance } from '../../src/adapters/wdk/RgbCore'

/**
 * AUDIT C-F4 — balance semantic corruption in the legacy RgbAdapter converters.
 *
 * The unified AssetBalance contract (as implemented by the single source of
 * truth, RgbCore.rgbAssetBalance) is:
 *   total   = owned  = future (projected total incl. unsettled)
 *   pending = future - settled
 * src/lib/rgb-converters.ts instead emits total=settled and pending=future
 * (the whole projected total), so callers that render total+pending double-count,
 * and a received-but-unconfirmed asset reports total = 0.
 */
describe('AUDIT C-F4: convertSdkBalance / convertNodeBalance semantics', () => {
  it('pending must be the unsettled delta (future - settled), not the projected total', () => {
    const sdk = { settled: 100, spendable: 100, future: 150, offchain_outbound: 0, offchain_inbound: 0 } as any
    const converted = convertSdkBalance(sdk)
    const core = rgbAssetBalance(sdk, 0)
    expect(core.pending, 'RgbCore reference semantics').toBe(50)
    expect(converted.pending, 'converter must match RgbCore').toBe(50)
  })

  it('a received-but-unconfirmed asset must count toward total', () => {
    const node = { settled: 0, spendable: 0, future: 500_000, offchain_outbound: 0, offchain_inbound: 0 }
    const converted = convertNodeBalance(node, 0)
    const core = rgbAssetBalance(node, 0)
    expect(core.total, 'RgbCore reference semantics').toBe(500_000)
    expect(converted.total, 'converter must match RgbCore').toBe(500_000)
  })
})
