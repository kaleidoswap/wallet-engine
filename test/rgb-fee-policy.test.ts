import { describe, it, expect } from 'vitest'
import { resolveRgbFeeRatePolicy, MAINNET_FEE_FLOOR } from '../src/lib/rgb-fee-policy'

const noEstimate = async () => null

describe('resolveRgbFeeRatePolicy', () => {
  it('honours a positive caller-provided rate', async () => {
    const rate = await resolveRgbFeeRatePolicy({ provided: 42, urgency: 'normal', network: 'mainnet', estimateFn: noEstimate })
    expect(rate).toBe(42)
  })

  it('returns 1 sat/vB on non-mainnet networks', async () => {
    for (const network of ['signet', 'testnet', 'regtest', null]) {
      const rate = await resolveRgbFeeRatePolicy({ provided: undefined, urgency: 'normal', network, estimateFn: noEstimate })
      expect(rate, `network=${network}`).toBe(1)
    }
  })

  it('applies the mainnet floor case-insensitively (a "MAINNET" label must not bypass it)', async () => {
    for (const network of ['mainnet', 'Mainnet', 'MAINNET']) {
      const rate = await resolveRgbFeeRatePolicy({ provided: undefined, urgency: 'normal', network, estimateFn: noEstimate })
      expect(rate, `network=${network}`).toBe(MAINNET_FEE_FLOOR.normal)
    }
  })

  it('rounds a fractional estimate UP (fee safety), then clamps to the floor', async () => {
    // Estimate above the floor: rounds up rather than down.
    const rate = await resolveRgbFeeRatePolicy({
      provided: undefined,
      urgency: 'high', // floor 25
      network: 'mainnet',
      estimateFn: async () => 30.1,
    })
    expect(rate).toBe(31)
  })
})
