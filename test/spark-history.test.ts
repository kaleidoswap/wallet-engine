import { describe, it, expect } from 'vitest'
import { SparkWdkAdapter } from '../src/adapters/wdk/SparkWdkAdapter'
import type { UnifiedTransaction } from '../src/types/base'
import {
  ME,
  directReceiveKeyTweaked,
  directSendInitiated,
  lightningReceivePending,
  onchainSendCompleted,
  lightningSendFailed,
  legacyDirectionReceive,
} from './fixtures/spark'

/**
 * Build a connected SparkWdkAdapter backed by a fake account that returns the
 * given transfers from getTransfers(). No WDK module is loaded — we inject the
 * internal state the adapter would otherwise set during connect().
 */
function adapterWith(transfers: any[], identityPubKeyHex: string | null = ME): SparkWdkAdapter {
  const adapter = new SparkWdkAdapter()
  Object.assign(adapter as any, {
    connected: true,
    identityPubKeyHex: identityPubKeyHex?.toLowerCase() ?? null,
    account: { getTransfers: async () => transfers },
  })
  return adapter
}

const byId = (txs: UnifiedTransaction[], id: string) => txs.find((t) => t.id === id)!

describe('SparkWdkAdapter.listTransactions (issue #3)', () => {
  it('marks a direct receive in key-tweak state as a confirmed receive', async () => {
    const [tx] = await adapterWith([directReceiveKeyTweaked]).listTransactions()
    expect(tx.type).toBe('receive')
    expect(tx.status).toBe('confirmed')
    expect(tx.amount).toBe(10_000)
  })

  it('marks a direct sender-initiated transfer as a confirmed send', async () => {
    const [tx] = await adapterWith([directSendInitiated]).listTransactions()
    expect(tx.type).toBe('send')
    expect(tx.status).toBe('confirmed')
    expect(tx.amount).toBe(5_000)
  })

  it('derives direction from identity keys for incoming and outgoing transfers', async () => {
    const txs = await adapterWith([directReceiveKeyTweaked, directSendInitiated]).listTransactions()
    expect(byId(txs, 'transfer-direct-receive').type).toBe('receive')
    expect(byId(txs, 'transfer-direct-send').type).toBe('send')
  })

  it('preserves pending status for an in-flight Lightning userRequest receive', async () => {
    const [tx] = await adapterWith([lightningReceivePending]).listTransactions()
    expect(tx.type).toBe('receive')
    expect(tx.status).toBe('pending')
  })

  it('preserves confirmed status for a completed on-chain userRequest send', async () => {
    const [tx] = await adapterWith([onchainSendCompleted]).listTransactions()
    expect(tx.type).toBe('send')
    expect(tx.status).toBe('confirmed')
  })

  it('preserves failed status for a failed Lightning userRequest send', async () => {
    const [tx] = await adapterWith([lightningSendFailed]).listTransactions()
    expect(tx.status).toBe('failed')
  })

  it('falls back to the legacy direction field when no identity key is known', async () => {
    const [tx] = await adapterWith([legacyDirectionReceive], null).listTransactions()
    expect(tx.type).toBe('receive')
  })

  it('parses ISO createdTime into an epoch-ms timestamp', async () => {
    const [tx] = await adapterWith([directReceiveKeyTweaked]).listTransactions()
    expect(tx.timestamp).toBe(Date.parse('2026-06-19T10:00:00.000Z'))
  })
})
