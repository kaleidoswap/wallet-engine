import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ wallet: null as unknown }))
vi.mock('../src/lib/spark-client-manager', () => ({
  sparkClientManager: {
    isInitialized: () => state.wallet !== null,
    ownsSession: () => state.wallet !== null,
    getWallet: () => state.wallet,
    getConfig: () => ({ protocol: 'SPARK', network: 'regtest', mnemonic: '' }),
  },
}))

import * as sdk from '@buildonspark/spark-sdk'
import { SparkAdapter } from '../src/adapters/SparkAdapter'
import { SparkWdkAdapter } from '../src/adapters/wdk/SparkWdkAdapter'
import { ProtocolManager } from '../src/manager/ProtocolManager'
import type { SigningPolicy } from '../src/policy'
import { testPubkey, sparkAddress } from './fixtures/spark-address'
import { sparkInvoiceAmount } from '../src/lib/spark-invoice-amount'

function invoice(kind: 'sats' | 'tokens', amount?: number) {
  return sdk.encodeSparkAddress({
    identityPublicKey: Buffer.from(testPubkey()).toString('hex'),
    network: 'REGTEST',
    sparkInvoiceFields: {
      version: 1,
      id: Uint8Array.from([0, 0, 0, 0, 0, 0, 0x40, 0, 0x80, 0, 0, 0, 0, 0, 0, 1]),
      paymentType: kind === 'sats'
        ? { $case: 'satsPayment', satsPayment: { amount } }
        : { $case: 'tokensPayment', tokensPayment: { tokenIdentifier: new Uint8Array(32).fill(1), amount: new Uint8Array([100]) } },
    },
  })
}

function setup(native: boolean, policy?: SigningPolicy) {
  const pay = vi.fn(async () => ({
    satsTransactionErrors: [],
    satsTransactionSuccess: [{ transferResponse: { id: 'transfer', totalValue: 100, status: 'COMPLETED' } }],
  }))
  const transfer = vi.fn(async () => ({ id: 'transfer', hash: 'transfer', totalValue: 100, status: 'COMPLETED' }))
  const wallet = { fulfillSparkInvoice: pay, transfer }
  state.wallet = wallet
  const adapter = native ? Object.assign(new SparkAdapter(), { connected: true })
    : Object.assign(new SparkWdkAdapter(), {
      connected: true, sdk, account: { paySparkInvoice: pay, sendTransaction: transfer, _wallet: wallet },
    })
  const manager = new ProtocolManager({ policy })
  manager.registerAdapter(adapter)
  ;(manager as any).activeProtocol = 'SPARK'
  return { manager, adapter, pay, transfer }
}

afterEach(() => { state.wallet = null })

describe.each([true, false])('Spark invoice terms (native=%s)', (native) => {
  it('authorises the encoded sats amount when no caller amount is supplied', async () => {
    const { manager, pay } = setup(native, { maxAmountSat: 100 })
    await manager.sendPayment({ invoice: invoice('sats', 100) })
    expect(pay).toHaveBeenCalledOnce()
    expect(pay.mock.calls[0]).toEqual([[{ invoice: invoice('sats', 100), amount: 100n }]])
  })

  it('refuses an encoded amount above the cap', async () => {
    const { manager, pay } = setup(native, { maxAmountSat: 99 })
    await expect(manager.sendPayment({ invoice: invoice('sats', 100) }))
      .rejects.toMatchObject({ code: 'AMOUNT_OVER_GLOBAL_LIMIT' })
    expect(pay).not.toHaveBeenCalled()
  })

  it('applies grant-only limits to the decoded amount', async () => {
    const { manager, pay } = setup(native, { grants: [{ id: 'app', operations: ['send'], maxAmountSat: 99 }] })
    manager.setActiveGrant('app')
    await expect(manager.sendPayment({ invoice: invoice('sats', 100) }))
      .rejects.toMatchObject({ code: 'AMOUNT_OVER_GRANT_LIMIT' })
    expect(pay).not.toHaveBeenCalled()
  })

  it('stops before payment when native decoding fails', async () => {
    const { manager, adapter, pay } = setup(native, { maxAmountSat: 100 })
    vi.spyOn(adapter, 'decodeInvoice').mockRejectedValueOnce(new Error('decode failed'))
    await expect(manager.sendPayment({ invoice: invoice('sats', 100), amount: 1 }))
      .rejects.toMatchObject({ code: 'AMOUNT_UNKNOWN' })
    expect(pay).not.toHaveBeenCalled()
  })

  it('refuses inconsistent caller and invoice amounts before paying', async () => {
    const { manager, adapter, pay } = setup(native, { maxAmountSat: 100 })
    await expect(manager.sendPayment({ invoice: invoice('sats', 1000), amount: 1 })).rejects.toThrow()
    await expect(adapter.sendPayment({ invoice: invoice('sats', 1000), amount: 1 })).rejects.toThrow(/differs/)
    expect(pay).not.toHaveBeenCalled()
  })

  it.each([undefined, {}, { maxAmountSat: 100 }, { maxAmountByAsset: { token: '100' } }])(
    'refuses token invoices in the BTC send path with policy %j', async (policy) => {
      const { manager, pay } = setup(native, policy)
      await expect(manager.sendPayment({ invoice: invoice('tokens'), amount: 1 })).rejects.toThrow()
      expect(pay).not.toHaveBeenCalled()
    },
  )

  it('uses the caller amount for amountless invoices and plain addresses', async () => {
    const { manager, pay, transfer } = setup(native, { maxAmountSat: 100 })
    await manager.sendPayment({ invoice: invoice('sats'), amount: 100 })
    await expect(manager.sendPayment({ invoice: invoice('sats'), amount: 101 })).rejects.toThrow()
    await expect(manager.sendPayment({ invoice: invoice('sats') })).rejects.toThrow()
    await manager.sendPayment({ invoice: sparkAddress('sparkrt'), amount: 100 })
    expect(pay).toHaveBeenCalledOnce()
    expect(transfer).toHaveBeenCalledOnce()
  })
})

it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '100'])('refuses invalid decoded sats %s', (amount) => {
  expect(() => sparkInvoiceAmount({ sparkInvoiceFields: { paymentType: { type: 'sats', amount } } })).toThrow()
})
