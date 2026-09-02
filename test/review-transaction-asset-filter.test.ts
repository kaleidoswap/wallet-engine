import { describe, expect, it } from 'vitest'
import type { IProtocolAdapter } from '../src/adapters/IProtocolAdapter'
import { ArkadeWdkAdapter } from '../src/adapters/wdk/ArkadeWdkAdapter'
import { LiquidWdkAdapter } from '../src/adapters/wdk/LiquidWdkAdapter'
import { RgbLibWasmAdapter } from '../src/adapters/wdk/RgbLibWasmAdapter'
import { RgbLibWdkAdapter } from '../src/adapters/wdk/RgbLibWdkAdapter'
import { RlnWdkAdapter } from '../src/adapters/wdk/RlnWdkAdapter'

function connected(adapter: IProtocolAdapter, account: Record<string, unknown>): IProtocolAdapter {
  Object.assign(adapter as unknown as Record<string, unknown>, { connected: true, account })
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
