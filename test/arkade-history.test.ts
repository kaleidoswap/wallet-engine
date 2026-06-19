import { describe, it, expect } from 'vitest'
import { ArkadeWdkAdapter } from '../src/adapters/wdk/ArkadeWdkAdapter'
import type { UnifiedTransaction } from '../src/types/base'
import {
  sentUnsettled,
  sentSettled,
  receivedOffchainUnsettled,
  boardingUnsettled,
  commitmentIdRow,
  emptyIdRow,
  TS_1,
  TS_3,
} from './fixtures/arkade'

function adapterWith(history: any[]): ArkadeWdkAdapter {
  const adapter = new ArkadeWdkAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account: { getTransactionHistory: async () => history },
  })
  return adapter
}

const one = (h: any[]): Promise<UnifiedTransaction> => adapterWith(h).listTransactions().then((t) => t[0])

describe('ArkadeWdkAdapter.listTransactions (issue #6)', () => {
  it('maps a SENT row to a send with id from arkTxid and absolute amount', async () => {
    const tx = await one([sentUnsettled])
    expect(tx.type).toBe('send')
    expect(tx.id).toBe('a'.repeat(64))
    expect(tx.amount).toBe(5_000)
    expect(tx.timestamp).toBe(TS_1) // ms, not multiplied by 1000
    expect(tx.protocolData).toBe(sentUnsettled)
  })

  it('marks a settled SENT row as confirmed', async () => {
    expect((await one([sentSettled])).status).toBe('confirmed')
  })

  it('marks a received off-chain (non-boarding) VTXO as confirmed, not pending', async () => {
    const tx = await one([receivedOffchainUnsettled])
    expect(tx.type).toBe('receive')
    expect(tx.status).toBe('confirmed')
    expect(tx.amount).toBe(8_000)
    expect(tx.timestamp).toBe(TS_3)
  })

  it('keeps an unsettled boarding row pending with id from boardingTxid', async () => {
    const tx = await one([boardingUnsettled])
    expect(tx.type).toBe('receive')
    expect(tx.status).toBe('pending')
    expect(tx.id).toBe('d'.repeat(64))
  })

  it('falls back to commitmentTxid when arkTxid is empty', async () => {
    expect((await one([commitmentIdRow])).id).toBe('e'.repeat(64))
  })

  it('returns an empty id when all key fields are empty (no crash)', async () => {
    const tx = await one([emptyIdRow])
    expect(tx.id).toBe('')
    expect(tx.type).toBe('receive')
  })

  it('does not push timestamps into the far future (no *1000 bug)', async () => {
    const txs = await adapterWith([sentUnsettled, receivedOffchainUnsettled]).listTransactions()
    for (const tx of txs) {
      expect(tx.timestamp).toBeLessThan(Date.parse('2100-01-01'))
    }
  })
})
