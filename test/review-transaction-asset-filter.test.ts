import { describe, expect, it } from 'vitest'
import type { IProtocolAdapter } from '../src/adapters/IProtocolAdapter'
import { ArkadeWdkAdapter } from '../src/adapters/wdk/ArkadeWdkAdapter'
import { LiquidWdkAdapter } from '../src/adapters/wdk/LiquidWdkAdapter'
import { RgbLibWasmAdapter } from '../src/adapters/wdk/RgbLibWasmAdapter'
import { RgbLibWdkAdapter } from '../src/adapters/wdk/RgbLibWdkAdapter'
import { RlnWdkAdapter } from '../src/adapters/wdk/RlnWdkAdapter'

function connected(adapter: IProtocolAdapter, account: Record<string, unknown>): IProtocolAdapter {
  // `wallet` alongside `account`: the Arkade adapter builds its SDK wallet
  // directly now, while the RLN and RGB adapters still go through a WDK
  // account. One helper serves both rather than splitting the table.
  Object.assign(adapter as unknown as Record<string, unknown>, { connected: true, account, wallet: account })
  return adapter
}

describe('BTC transaction asset filters', () => {
  const cases: Array<[string, () => IProtocolAdapter]> = [
    ['RlnWdkAdapter', () => connected(new RlnWdkAdapter(), {
      listTransactions: async () => ({ transactions: [{ txid: 'rln', received: 1 }] }),
    })],
    ['RgbLibWdkAdapter', () => connected(new RgbLibWdkAdapter(), {
      listTransactions: async () => [{ txid: 'rgb-native', received: 1 }],
    })],
    ['RgbLibWasmAdapter', () => connected(new RgbLibWasmAdapter(), {
      listTransactions: async () => [{ txid: 'rgb-wasm', received: 1 }],
    })],
    ['ArkadeWdkAdapter', () => connected(new ArkadeWdkAdapter(), {
      getTransactionHistory: async () => [{ key: { arkTxid: 'ark' }, type: 'RECEIVED', amount: 1 }],
    })],
    ['LiquidWdkAdapter without policy metadata', () => connected(new LiquidWdkAdapter(), {
      getNetworkInfo: async () => { throw new Error('offline') },
      listTransactions: async () => [{ txid: 'liquid', type: 'incoming', fee: '0', height: 1, timestamp: 1 }],
    })],
  ]

  it.each(cases)('%s retains BTC rows for an asset-scoped query', async (_name, makeAdapter) => {
    const transactions = await makeAdapter().listTransactions({ asset: 'BTC' })
    expect(transactions).toHaveLength(1)
    expect(transactions[0].asset.id).toBe('BTC')
  })
})

/**
 * The same query, against a Liquid adapter that CAN identify its policy asset.
 *
 * The table above only ever exercised the adapter's fallback, which labels an
 * L-BTC row `'BTC'`. With the policy asset known the row carries the policy
 * hex instead, and `asset: 'BTC'` used to drop it — so `listTransactions({
 * asset: 'BTC' })` answered differently depending on whether the adapter had
 * resolved the policy asset yet, for the same wallet and the same rows (#73).
 */
describe('Liquid L-BTC rows answer to BTC whether or not the policy asset is known', () => {
  const POLICY = '144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49'

  const withPolicy = () =>
    connected(new LiquidWdkAdapter(), {
      getNetworkInfo: async () => ({ network: 'testnet', policy_asset: POLICY, tip_height: 1 }),
      listTransactions: async () => [
        {
          txid: 'liquid',
          type: 'incoming',
          fee: '0',
          height: 1,
          timestamp: 1,
          balance: [{ asset_id: POLICY, value: '1000' }],
        },
      ],
    })

  it('keeps the policy-asset hex as the row identity', async () => {
    const [tx] = await withPolicy().listTransactions()
    expect(tx.asset.id).toBe(POLICY)
    expect(tx.asset.layer).toBe('BTC_LIQUID')
  })

  it('matches a BTC-scoped query anyway', async () => {
    const transactions = await withPolicy().listTransactions({ asset: 'BTC' })
    expect(transactions).toHaveLength(1)
    expect(transactions[0].asset.id).toBe(POLICY)
  })

  it('still matches a query for the policy asset itself', async () => {
    const transactions = await withPolicy().listTransactions({ asset: POLICY })
    expect(transactions).toHaveLength(1)
  })

  it('does not let BTC sweep up a non-bitcoin Liquid asset', async () => {
    const adapter = connected(new LiquidWdkAdapter(), {
      getNetworkInfo: async () => ({ network: 'testnet', policy_asset: POLICY, tip_height: 1 }),
      listTransactions: async () => [
        {
          txid: 'usdt',
          type: 'incoming',
          fee: '0',
          height: 1,
          timestamp: 1,
          balance: [{ asset_id: 'ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2', value: '5' }],
        },
      ],
    })
    expect(await adapter.listTransactions({ asset: 'BTC' })).toHaveLength(0)
  })
})
