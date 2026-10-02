import { afterEach, describe, expect, it, vi } from 'vitest'

const sparkState = vi.hoisted(() => ({ wallet: null as unknown }))
vi.mock('../src/lib/spark-client-manager', () => ({
  sparkClientManager: {
    isInitialized: () => sparkState.wallet !== null,
    getWallet: () => sparkState.wallet,
    getConfig: () => ({ protocol: 'SPARK', network: 'regtest', mnemonic: '' }),
    initialize: async () => {},
    disconnect: async () => {},
    adoptExternalWallet: () => {},
    releaseExternalWallet: () => {},
  },
}))

import { SparkAdapter } from '../src/adapters/SparkAdapter'
import { isSparkAddressSafe } from '../src/lib/spark-helpers'

const BTC_ADDRESS = 'bcrt1pzflae0sdljvlsacfdce8aum8dtgd2f5fvpjujze8wa6azh45z8wsg0ulw9'

afterEach(() => {
  sparkState.wallet = null
})

describe('isSparkAddressSafe', () => {
  it('reads a throwing validator as "not a Spark address"', () => {
    const throwing = () => {
      throw new Error('Invalid Spark address prefix')
    }
    expect(isSparkAddressSafe(BTC_ADDRESS, throwing)).toBe(false)
    expect(isSparkAddressSafe('sparkrt1x', () => true)).toBe(true)
    expect(isSparkAddressSafe('sparkrt1x', undefined)).toBe(false)
  })
})

describe('SparkAdapter.sendPayment on-chain destination', () => {
  it('withdraws to a Bitcoin address with the real SDK validator', async () => {
    const withdraw = vi.fn(async () => ({ id: 'exit-1', fee: { originalValue: 750 } }))
    sparkState.wallet = {
      getWithdrawalFeeQuote: async () => ({
        id: 'quote-1',
        l1BroadcastFeeMedium: { originalValue: 1440 },
        userFeeMedium: { originalValue: 750 },
      }),
      withdraw,
    }
    const adapter = new SparkAdapter()
    Object.assign(adapter as any, { connected: true })
    const result = await adapter.sendPayment({ invoice: BTC_ADDRESS, amount: 10_000 } as any)
    expect(withdraw).toHaveBeenCalledWith(
      expect.objectContaining({ onchainAddress: BTC_ADDRESS, amountSats: 10_000, feeQuoteId: 'quote-1', feeAmountSats: 2190 }),
    )
    expect(result).toMatchObject({ paymentHash: 'exit-1', status: 'pending' })
  })
})
