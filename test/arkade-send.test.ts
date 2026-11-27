import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArkadeAdapter } from '../src/adapters/ArkadeAdapter'
import { arkadeClientManager } from '../src/lib/arkade-client-manager'

const ARK_ADDR = 'tark1qexampleexampleexampleexampleexampleexampleexampleexample'
const FUTURE = Date.now() + 86_400_000

function vtxo(txid: string, value: number, batchExpiry: number, assets?: unknown[]) {
  return {
    txid,
    vout: 0,
    value,
    status: { confirmed: true },
    virtualStatus: { state: 'settled', batchExpiry },
    isSpent: false,
    isUnrolled: false,
    createdAt: new Date(),
    ...(assets ? { assets } : {}),
  }
}

function connectedAdapter(vtxos: unknown[]) {
  const wallet = {
    getVtxos: vi.fn(async () => vtxos),
    send: vi.fn(async () => 'arktxid'),
    sendOnchain: vi.fn(async () => 'onchaintxid'),
  }
  vi.spyOn(arkadeClientManager, 'isInitialized').mockReturnValue(true)
  vi.spyOn(arkadeClientManager, 'ownsSession').mockReturnValue(true)
  vi.spyOn(arkadeClientManager, 'getWallet').mockReturnValue(wallet as never)
  return { adapter: new ArkadeAdapter(), wallet }
}

afterEach(() => vi.restoreAllMocks())

describe('ArkadeAdapter BTC sends spend VTXOs off-chain via send()', () => {
  const soon = vtxo('a'.repeat(64), 3_000, FUTURE - 3_600_000)
  const later = vtxo('b'.repeat(64), 5_000, FUTURE)
  const withAsset = vtxo('c'.repeat(64), 100_000, FUTURE - 7_200_000, [{ assetId: 'asset-1', amount: 5n }])

  for (const [name, call] of [
    ['sendPayment', (a: ArkadeAdapter) => a.sendPayment({ invoice: ARK_ADDR, amount: 4_000 } as never)],
    ['sendBtcOnchain', (a: ArkadeAdapter) => a.sendBtcOnchain({ address: ARK_ADDR, amount: 4_000 })],
  ] as const) {
    it(`${name}: passes the selected BTC-only VTXOs as selectedVtxos, never sendOnchain`, async () => {
      const { adapter, wallet } = connectedAdapter([later, withAsset, soon])
      await call(adapter)
      expect(wallet.sendOnchain).not.toHaveBeenCalled()
      expect(wallet.send).toHaveBeenCalledTimes(1)
      expect(wallet.send).toHaveBeenCalledWith({
        recipients: [{ address: ARK_ADDR, amount: 4_000 }],
        selectedVtxos: [soon, later],
      })
    })

    it(`${name}: leaves selection to the SDK when BTC-only VTXOs cannot cover the amount`, async () => {
      const { adapter, wallet } = connectedAdapter([soon, withAsset])
      await call(adapter)
      expect(wallet.sendOnchain).not.toHaveBeenCalled()
      expect(wallet.send).toHaveBeenCalledWith({ recipients: [{ address: ARK_ADDR, amount: 4_000 }] })
    })
  }

  it('returns the send() txid', async () => {
    const { adapter } = connectedAdapter([soon, later])
    const r = await adapter.sendPayment({ invoice: ARK_ADDR, amount: 4_000 } as never)
    expect(r).toMatchObject({ paymentHash: 'arktxid', amount: 4_000 })
    expect(await adapter.sendBtcOnchain({ address: ARK_ADDR, amount: 4_000 })).toEqual({ txid: 'arktxid' })
  })
})
