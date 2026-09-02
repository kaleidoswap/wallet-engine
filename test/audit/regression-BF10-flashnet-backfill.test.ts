import { afterEach, describe, expect, it, vi } from 'vitest'

const flashnetState = {
  swaps: [] as any[],
}

vi.mock('@flashnet/sdk', () => {
  class FakeFlashnetClient {
    async initialize() {}
    async listPools() { return [] }
    async getUserSwaps() { return { swaps: flashnetState.swaps } }
    async cleanup() {}
  }
  return { FlashnetClient: FakeFlashnetClient }
})

import { flashnetClientManager } from '../../src/lib/flashnet-client-manager'
import { getPlatform, setPlatform } from '../../src/ports'
import { loadSentTokenRecords } from '../../src/lib/spark-sent-token-records'

const hashBytes = (byte: number) => new Uint8Array(32).fill(byte)

afterEach(async () => {
  await flashnetClientManager.disconnect()
  flashnetState.swaps = []
})

describe('B-F10: Flashnet cannot forge the Spark sent-token outbox', () => {
  it('rejects a server-nominated transaction whose spent output is not wallet-owned', async () => {
    const previous = hashBytes(1)
    const candidate = hashBytes(2)
    const candidateHex = Array.from(candidate, (b) => b.toString(16).padStart(2, '0')).join('')
    const walletIdentity = '03'.repeat(33)
    const attackerIdentity = new Uint8Array(33).fill(4)
    const rowsByCall = [
      {
        tokenTransactionsWithStatus: [{
          tokenTransactionHash: candidate,
          tokenTransaction: {
            tokenInputs: {
              $case: 'transferInput',
              transferInput: {
                outputsToSpend: [{ prevTokenTransactionHash: previous, prevTokenTransactionVout: 0 }],
              },
            },
          },
        }],
      },
      {
        tokenTransactionsWithStatus: [{
          tokenTransactionHash: previous,
          tokenTransaction: { tokenOutputs: [{ ownerPublicKey: attackerIdentity }] },
        }],
      },
    ]
    const queryTokenTransactionsByTxHashes = vi.fn(async () => rowsByCall.shift())
    const wallet = {
      getSparkAddress: async () => 'spark1wallet',
      getIdentityPublicKey: async () => walletIdentity,
      queryTokenTransactionsByTxHashes,
    }
    flashnetState.swaps = [{
      assetInAddress: 'btkn1attacker',
      inboundTransferId: candidateHex,
      amountIn: '100',
      timestamp: '2026-08-30T00:00:00.000Z',
    }]

    const previousPlatform = getPlatform()
    const values = new Map<string, string>()
    setPlatform({
      storage: {
        get: async (key) => values.get(key) ?? null,
        set: async (key, value) => { values.set(key, value) },
        remove: async (key) => { values.delete(key) },
        keys: async () => [...values.keys()],
      },
      runtime: { host: 'node', randomBytes: (n) => new Uint8Array(n), now: () => 0 },
    })
    try {
      await flashnetClientManager.initialize(wallet as never, 'regtest')
      await vi.waitFor(() => expect(queryTokenTransactionsByTxHashes).toHaveBeenCalledTimes(2))
      expect(await loadSentTokenRecords()).toEqual([])
    } finally {
      if (previousPlatform) setPlatform(previousPlatform)
    }
  })
})
