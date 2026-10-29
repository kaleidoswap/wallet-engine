/**
 * Security review 2026-10-28, finding 17: the spend policy authorised only the
 * invoice principal, while Spark selects leaves for `principal + maxFeeSats`.
 * A caller could pay an invoice for exactly the cap with a large fee budget
 * and debit the wallet above the authorised amount. Native Spark also read a
 * legacy `maxFee` alias and ignored the documented `maxFeeSats`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const sparkState = vi.hoisted(() => ({ wallet: null as unknown }))
vi.mock('../src/lib/spark-client-manager', () => ({
  sparkClientManager: {
    isInitialized: () => sparkState.wallet !== null,
    getWallet: () => sparkState.wallet,
    getConfig: () => ({ protocol: 'SPARK', network: 'regtest', mnemonic: '' }),
    initialize: async () => {},
    disconnect: async () => {},
    adoptExternalWallet: () => {},
    releaseExternalWallet: () => {},
  },
}))

import { ProtocolManager } from '../src/manager/ProtocolManager'
import { PolicyError, type SigningPolicy } from '../src/policy'
import { SparkAdapter } from '../src/adapters/SparkAdapter'
import { SparkWdkAdapter } from '../src/adapters/wdk/SparkWdkAdapter'
import { DEFAULT_SPARK_MAX_FEE_SATS, resolveSparkMaxFeeSats } from '../src/lib/spark-fee-budget'
import { MemoAdapter } from '../examples/minimal-adapter/MemoAdapter'
import { bolt11Fixture, TEST_PREIMAGE } from './fixtures/bolt11'

// lnbc10u encodes exactly 1000 sats; lnbc9u 900 sats.
const INV_1000 = bolt11Fixture({ hrp: 'lnbc10u' })
const INV_900 = bolt11Fixture({ hrp: 'lnbc9u' })
const AMOUNTLESS = bolt11Fixture({ hrp: 'lnbc' })

describe('resolveSparkMaxFeeSats', () => {
  it('prefers maxFeeSats, then the legacy maxFee alias, then the default budget', () => {
    expect(resolveSparkMaxFeeSats({})).toBe(DEFAULT_SPARK_MAX_FEE_SATS)
    expect(resolveSparkMaxFeeSats({ maxFeeSats: 25 })).toBe(25)
    expect(resolveSparkMaxFeeSats({ maxFee: 30 })).toBe(30)
    expect(resolveSparkMaxFeeSats({ maxFeeSats: 25, maxFee: 30 })).toBe(25)
    expect(resolveSparkMaxFeeSats({ maxFeeSats: 0 })).toBe(0)
  })

  it('refuses a budget that is not a non-negative safe integer', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '100', null as unknown]) {
      if (bad === null) continue
      expect(() => resolveSparkMaxFeeSats({ maxFeeSats: bad })).toThrow(/maxFeeSats/)
      expect(() => resolveSparkMaxFeeSats({ maxFee: bad })).toThrow(/maxFeeSats/)
    }
  })
})

// --- the policy sees principal + fee budget ---------------------------------

function sparkWallet() {
  const payLightningInvoice = vi.fn(async (opts: any) => ({
    id: 'SparkLightningSendRequest:req-1',
    createdAt: '2026-10-28T10:00:00.000Z',
    encodedInvoice: opts.invoice,
    fee: { originalValue: 2, originalUnit: 'SATOSHI' },
    status: 'LIGHTNING_PAYMENT_SUCCEEDED',
    paymentPreimage: TEST_PREIMAGE,
  }))
  return { payLightningInvoice }
}

function nativeAdapter(wallet: unknown) {
  sparkState.wallet = wallet
  return Object.assign(new SparkAdapter(), { connected: true })
}

function wdkAdapter(wallet: any) {
  return Object.assign(new SparkWdkAdapter(), {
    connected: true,
    account: { payLightningInvoice: wallet.payLightningInvoice, _wallet: wallet },
  })
}

function managerWith(policy: SigningPolicy | undefined, adapter: SparkAdapter | SparkWdkAdapter) {
  const manager = new ProtocolManager({ policy })
  manager.registerAdapter(adapter)
  ;(manager as any).activeProtocol = 'SPARK'
  return manager
}

afterEach(() => {
  sparkState.wallet = null
})

describe.each([
  ['SparkAdapter', nativeAdapter],
  ['SparkWdkAdapter', wdkAdapter],
] as const)('%s: the per-transaction cap covers principal plus fee budget', (_name, make) => {
  it('an invoice for exactly the cap with any fee budget is over the cap', async () => {
    const wallet = sparkWallet()
    const manager = managerWith({ maxAmountSat: 1000 }, make(wallet))
    await expect(manager.sendPayment({ invoice: INV_1000, maxFeeSats: 1 })).rejects.toMatchObject({
      name: 'PolicyError',
      code: 'AMOUNT_OVER_GLOBAL_LIMIT',
    })
    expect(wallet.payLightningInvoice).not.toHaveBeenCalled()
  })

  it('the native default budget counts when the caller gives none', async () => {
    const wallet = sparkWallet()
    const manager = managerWith({ maxAmountSat: 1000 }, make(wallet))
    // 900 sats principal + 1000 sats default budget > 1000.
    await expect(manager.sendPayment({ invoice: INV_900 })).rejects.toMatchObject({ code: 'AMOUNT_OVER_GLOBAL_LIMIT' })
    expect(wallet.payLightningInvoice).not.toHaveBeenCalled()
  })

  it('the legacy maxFee alias counts the same as maxFeeSats', async () => {
    const wallet = sparkWallet()
    const manager = managerWith({ maxAmountSat: 1000 }, make(wallet))
    await expect(manager.sendPayment({ invoice: INV_900, maxFee: 101 } as any)).rejects.toMatchObject({ code: 'AMOUNT_OVER_GLOBAL_LIMIT' })
    expect(wallet.payLightningInvoice).not.toHaveBeenCalled()
  })

  it('principal plus a bounded budget at or under the cap pays, with that exact budget forwarded', async () => {
    const wallet = sparkWallet()
    const manager = managerWith({ maxAmountSat: 1000 }, make(wallet))
    const result = await manager.sendPayment({ invoice: INV_900, maxFeeSats: 100 })
    expect(result).toMatchObject({ amount: 900, status: 'confirmed' })
    expect(wallet.payLightningInvoice).toHaveBeenCalledWith(expect.objectContaining({ invoice: INV_900, maxFeeSats: 100 }))

    const zeroBudget = managerWith({ maxAmountSat: 1000 }, make(sparkWallet()))
    await expect(zeroBudget.sendPayment({ invoice: INV_1000, maxFeeSats: 0 })).resolves.toMatchObject({ amount: 1000 })
  })

  it('an amountless invoice authorises the caller amount plus the budget', async () => {
    const wallet = sparkWallet()
    const manager = managerWith({ maxAmountSat: 1000 }, make(wallet))
    await expect(manager.sendPayment({ invoice: AMOUNTLESS, amount: 900, maxFeeSats: 101 })).rejects.toMatchObject({
      code: 'AMOUNT_OVER_GLOBAL_LIMIT',
    })
    await manager.sendPayment({ invoice: AMOUNTLESS, amount: 900, maxFeeSats: 100 })
    expect(wallet.payLightningInvoice).toHaveBeenCalledWith(expect.objectContaining({ amountSatsToSend: 900, maxFeeSats: 100 }))
  })

  it('a grant cap covers the budget as well', async () => {
    const wallet = sparkWallet()
    const manager = managerWith(
      { mode: 'deny', grants: [{ id: 'app', operations: ['send'], maxAmountSat: 1000 }] },
      make(wallet),
    )
    manager.setActiveGrant('app')
    await expect(manager.sendPayment({ invoice: INV_1000, maxFeeSats: 1 })).rejects.toMatchObject({ code: 'AMOUNT_OVER_GRANT_LIMIT' })
    await manager.sendPayment({ invoice: INV_1000, maxFeeSats: 0 })
    expect(wallet.payLightningInvoice).toHaveBeenCalledTimes(1)
  })

  it('a malformed or overflowing budget fails closed under a cap', async () => {
    const wallet = sparkWallet()
    const manager = managerWith({ maxAmountSat: Number.MAX_SAFE_INTEGER }, make(wallet))
    for (const maxFeeSats of [-1, 1.5, Number.NaN, '5' as unknown as number]) {
      await expect(manager.sendPayment({ invoice: INV_900, maxFeeSats })).rejects.toMatchObject({ code: 'AMOUNT_UNKNOWN' })
    }
    await expect(
      manager.sendPayment({ invoice: INV_900, maxFeeSats: Number.MAX_SAFE_INTEGER }),
    ).rejects.toMatchObject({ code: 'AMOUNT_UNKNOWN' })
    expect(wallet.payLightningInvoice).not.toHaveBeenCalled()
  })

  it('the adapter itself honours maxFeeSats, the alias and the default, and refuses a malformed budget', async () => {
    const wallet = sparkWallet()
    const adapter = make(wallet)
    await adapter.sendPayment({ invoice: INV_900, maxFeeSats: 7 })
    await adapter.sendPayment({ invoice: INV_900, maxFee: 8 } as any)
    await adapter.sendPayment({ invoice: INV_900 })
    expect(wallet.payLightningInvoice.mock.calls.map((c: any[]) => c[0].maxFeeSats)).toEqual([7, 8, DEFAULT_SPARK_MAX_FEE_SATS])
    // The native adapter wraps SDK-path errors; the message carries the cause either way.
    await expect(adapter.sendPayment({ invoice: INV_900, maxFeeSats: -1 })).rejects.toThrow(/Invalid maxFeeSats/)
    expect(wallet.payLightningInvoice).toHaveBeenCalledTimes(3)
  })
})

describe('the fee budget is Spark-specific', () => {
  it('a non-Spark adapter is capped on the principal alone', async () => {
    const manager = new ProtocolManager({ defaultProtocol: 'BTC', policy: { maxAmountSat: 1000 } })
    manager.registerAdapter(new MemoAdapter())
    await manager.connect('BTC', { protocol: 'BTC' })
    await expect(manager.sendPayment({ invoice: INV_1000, maxFeeSats: 5000 })).resolves.toMatchObject({ status: 'confirmed' })
  })

  it('a Spark non-Lightning destination carries no fee budget', async () => {
    const manager = managerWith({ maxAmountSat: 1000 }, wdkAdapter(sparkWallet()))
    // The policy passes; the (unmocked) Spark address send then fails in the adapter, not the policy.
    const err = await manager.sendPayment({ invoice: 'sprt1pgss9notarealaddress', amount: 1000, maxFeeSats: 5000 }).catch((e) => e)
    expect(err).not.toBeInstanceOf(PolicyError)
  })
})
