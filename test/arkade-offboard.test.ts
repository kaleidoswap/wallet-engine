import { describe, it, expect } from 'vitest'
import { ArkadeWdkAdapter } from '../src/adapters/wdk/ArkadeWdkAdapter'

/** Connected adapter whose account.sendTransaction returns the given result. */
function adapterSending(result: any) {
  const calls: any[] = []
  const adapter = new ArkadeWdkAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account: {
      sendTransaction: async (args: any) => {
        calls.push(args)
        return result
      },
    },
  })
  return { adapter, calls }
}

const ARK_ADDR = 'tark1qexampleexampleexampleexampleexampleexampleexampleexample'
const BTC_ADDR = 'bc1qexampleexampleexampleexampleexampleexample'

describe('ArkadeWdkAdapter.sendPayment (issue #5)', () => {
  it('returns a tx id/hash and confirms an off-chain Ark address send', async () => {
    const { adapter } = adapterSending({ hash: 'arktxid123', fee: 7 })
    const r = await adapter.sendPayment({ invoice: ARK_ADDR, amount: 4_000 } as any)
    expect(r.txid).toBe('arktxid123')
    expect(r.paymentHash).toBe('arktxid123')
    expect(r.amount).toBe(4_000)
    expect(r.fee).toBe(7)
    expect(r.status).toBe('confirmed')
  })

  it('treats a Bitcoin address destination as pending, not immediate', async () => {
    const { adapter } = adapterSending({ hash: 'btctxid456' })
    const r = await adapter.sendPayment({ invoice: BTC_ADDR, amount: 9_000 } as any)
    expect(r.status).toBe('pending')
    expect(r.txid).toBe('btctxid456')
  })
})

describe('ArkadeWdkAdapter.sendBtcOnchain (issue #5)', () => {
  it('submits an offboard and returns a pending result with a tx id', async () => {
    const { adapter, calls } = adapterSending({ hash: 'offboardtxid', fee: 50 })
    const r = await adapter.sendBtcOnchain({ address: BTC_ADDR, amount: 25_000 })
    expect(r.status).toBe('pending')
    expect(r.txid).toBe('offboardtxid')
    expect(r.paymentHash).toBe('offboardtxid')
    expect(r.amount).toBe(25_000)
    expect(r.fee).toBe(50)
    expect(calls[0]).toEqual({ to: BTC_ADDR, value: 25_000 })
  })

  it('throws a send error when the offboard returns no tx id/hash', async () => {
    const { adapter } = adapterSending({ hash: '' })
    await expect(adapter.sendBtcOnchain({ address: BTC_ADDR, amount: 1_000 })).rejects.toThrow(
      /did not return a transaction id/i,
    )
  })
})
