import { describe, it, expect } from 'vitest'
import { ArkadeWdkAdapter } from '../src/adapters/wdk/ArkadeWdkAdapter'

/**
 * Connected adapter whose wallet.sendBitcoin returns the given txid.
 *
 * `txFeeRate: '1'` makes the estimate readable: the adapter charges the
 * operator's rate over an assumed 150 vB offchain and 165 vB onchain, the same
 * sizes `@arkade-os/wdk` assumed before the Arkade path moved to the SDK
 * directly — so the `fee` a caller reads did not change with that move.
 */
function adapterSending(txid: string) {
  const calls: any[] = []
  const adapter = new ArkadeWdkAdapter()
  Object.assign(adapter as any, {
    connected: true,
    arkInfo: { fees: { txFeeRate: '1' } },
    wallet: {
      sendBitcoin: async (args: any) => {
        calls.push(args)
        return txid
      },
    },
  })
  return { adapter, calls }
}

const OFFCHAIN_FEE = 150
const ONCHAIN_FEE = 165

const ARK_ADDR = 'tark1qexampleexampleexampleexampleexampleexampleexampleexample'
const BTC_ADDR = 'bc1qexampleexampleexampleexampleexampleexample'

describe('ArkadeWdkAdapter.sendPayment (issue #5)', () => {
  it('returns a tx id/hash and confirms an off-chain Ark address send', async () => {
    const { adapter } = adapterSending('arktxid123')
    const r = await adapter.sendPayment({ invoice: ARK_ADDR, amount: 4_000 } as any)
    expect(r.txid).toBe('arktxid123')
    expect(r.paymentHash).toBe('arktxid123')
    expect(r.amount).toBe(4_000)
    expect(r.fee).toBe(OFFCHAIN_FEE)
    expect(r.status).toBe('confirmed')
  })

  it('treats a Bitcoin address destination as pending, not immediate', async () => {
    const { adapter } = adapterSending('btctxid456')
    const r = await adapter.sendPayment({ invoice: BTC_ADDR, amount: 9_000 } as any)
    expect(r.status).toBe('pending')
    expect(r.txid).toBe('btctxid456')
  })

  it('throws (not silent success) for a BTC destination that returns no tx id', async () => {
    const { adapter } = adapterSending('')
    await expect(adapter.sendPayment({ invoice: BTC_ADDR, amount: 9_000 } as any)).rejects.toThrow(
      /did not return a transaction id/i,
    )
  })
})

describe('ArkadeWdkAdapter.sendBtcOnchain (issue #5)', () => {
  it('submits an offboard and returns a pending result with a tx id', async () => {
    const { adapter, calls } = adapterSending('offboardtxid')
    const r = await adapter.sendBtcOnchain({ address: BTC_ADDR, amount: 25_000 })
    expect(r.status).toBe('pending')
    expect(r.txid).toBe('offboardtxid')
    expect(r.paymentHash).toBe('offboardtxid')
    expect(r.amount).toBe(25_000)
    expect(r.fee).toBe(ONCHAIN_FEE)
    expect(calls[0]).toEqual({ address: BTC_ADDR, amount: 25_000 })
  })

  it('throws a send error when the offboard returns no tx id/hash', async () => {
    const { adapter } = adapterSending('')
    await expect(adapter.sendBtcOnchain({ address: BTC_ADDR, amount: 1_000 })).rejects.toThrow(
      /did not return a transaction id/i,
    )
  })
})
