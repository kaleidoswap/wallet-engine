import { afterEach, describe, expect, it, vi } from 'vitest'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'

afterEach(() => vi.restoreAllMocks())

function disconnectedAdapter(): RgbAdapter {
  vi.spyOn(kaleidoClientManager, 'hasNode').mockReturnValue(true)
  vi.spyOn(kaleidoClientManager, 'isInitialized').mockReturnValue(true)
  vi.spyOn(kaleidoClientManager, 'getClient').mockReturnValue({
    rln: {
      getBtcBalance: async () => ({ vanilla: { settled: 1, future: 1, spendable: 1 } }),
      decodeLNInvoice: async () => ({ amt_msat: 1000 }),
      listChannels: async () => [],
      listPayments: async () => [],
      refreshTransfers: async () => undefined,
    },
  } as never)
  return new RgbAdapter()
}

const READS: ReadonlyArray<[string, (adapter: RgbAdapter) => Promise<unknown>]> = [
  ['getAssetBalance', (adapter) => adapter.getAssetBalance('BTC')],
  ['decodeInvoice', (adapter) => adapter.decodeInvoice('lnbc1example')],
  ['getBtcBalance', (adapter) => adapter.getBtcBalance()],
  ['listChannels', (adapter) => adapter.listChannels()],
  ['listPayments', (adapter) => adapter.listPayments()],
  ['refreshBalances', (adapter) => adapter.refreshBalances()],
]

describe('G-F6 read residual: node configuration is not a connection', () => {
  for (const [name, call] of READS) {
    it(`${name} rejects when only the exported singleton is initialized`, async () => {
      const adapter = disconnectedAdapter()
      expect(adapter.isConnected()).toBe(false)
      await expect(call(adapter)).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
    })
  }
})
