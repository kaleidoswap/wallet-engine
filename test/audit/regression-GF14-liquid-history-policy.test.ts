import { describe, expect, it } from 'vitest'
import { LiquidWdkAdapter } from '../../src/adapters/wdk/LiquidWdkAdapter'
import { LIQUID_USDT_ASSET_ID } from '../../src/constants'

describe('G-F14 residual: Liquid history survives policy lookup outage accurately', () => {
  it('infers the fee asset from deltas, labels L-BTC, and strips its fee', async () => {
    const policy = 'policy-asset-id'
    const adapter = new LiquidWdkAdapter()
    Object.assign(adapter as never, {
      connected: true,
      account: {
        getNetworkInfo: async () => { throw new Error('esplora temporarily down') },
        listTransactions: async () => [
          {
            txid: 'btc-send', type: 'outgoing', fee: '20', height: 1, timestamp: 1,
            balance: [{ asset_id: policy, value: '-1120' }],
          },
          {
            txid: 'usdt-send', type: 'outgoing', fee: '30', height: 2, timestamp: 2,
            balance: [
              { asset_id: policy, value: '-30' },
              { asset_id: LIQUID_USDT_ASSET_ID, value: '-250' },
            ],
          },
        ],
      },
    })

    const txs = await adapter.listTransactions()
    const btc = txs.find((tx) => tx.id === 'btc-send')!
    expect(btc.amount).toBe(1100)
    expect(btc.asset).toMatchObject({ id: policy, ticker: 'L-BTC', layer: 'BTC_LIQUID' })
    expect(txs.find((tx) => tx.id === 'usdt-send')!.asset).toMatchObject({
      id: LIQUID_USDT_ASSET_ID,
      ticker: 'USDt',
      layer: 'LIQUID_ASSET',
    })
  })
})
