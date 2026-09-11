import { describe, it, expect } from 'vitest'
import { ProtocolManager } from '../../src/manager/ProtocolManager'
import { PolicyError } from '../../src/policy'
import type { IProtocolAdapter } from '../../src/adapters/IProtocolAdapter'
import { PROTOCOL_OPERATIONS } from '../../src/capabilities/operations'

/**
 * Audit finding F-F1 — the policy checked an amount the adapters discard.
 *
 * Commit 32c351c (#55, findings H2/L4) changed the adapters to forward the
 * caller's `amount` ONLY for amountless invoices, so an amount-bearing invoice is
 * always paid for the amount it encodes (SparkAdapter.ts:691, RlnWdkAdapter.ts:331).
 * `ProtocolManager.resolveSendAmountSat` was not updated to match: it returned
 * `request.amount` first, so a caller could declare a small amount alongside a
 * large invoice and have the policy evaluate the small one while the wallet paid
 * the large one.
 */
// lnbc10m… encodes 10 mBTC = 1,000,000 sats.
const BIG_INVOICE = 'lnbc10m1pexampleinvoice'
const AMOUNTLESS = 'lnbc1pexampleinvoice'

function managerWith(policy: any) {
  const paid: any[] = []
  const adapter = {
    protocolName: 'SPARK', supportedLayers: [], version: 't',
    capabilities: PROTOCOL_OPERATIONS.SPARK,
    isConnected: () => true,
    connect: async () => {},
    sendPayment: async (r: any) => { paid.push(r); return { paymentHash: 'h', amount: 0, status: 'succeeded' } },
  } as unknown as IProtocolAdapter
  const m = new ProtocolManager({ policy, allowUnsafeAdapterAccess: true } as any)
  m.registerAdapter(adapter)
  ;(m as any).activeProtocol = 'SPARK'
  return { m, paid }
}

describe('F-F1: the spend cap must see the amount that will actually be paid', () => {
  it('a small declared amount cannot smuggle a large amount-bearing invoice past the cap', async () => {
    const { m, paid } = managerWith({ maxAmountSat: 1000 })
    await expect(m.sendPayment({ invoice: BIG_INVOICE, amount: 500 } as any))
      .rejects.toBeInstanceOf(PolicyError)
    expect(paid, 'the payment must never reach the adapter').toHaveLength(0)
  })

  it('the same invoice with no declared amount is still denied', async () => {
    const { m } = managerWith({ maxAmountSat: 1000 })
    await expect(m.sendPayment({ invoice: BIG_INVOICE } as any)).rejects.toBeInstanceOf(PolicyError)
  })

  it('an invoice within the cap still pays', async () => {
    const { m, paid } = managerWith({ maxAmountSat: 2_000_000 })
    await m.sendPayment({ invoice: BIG_INVOICE, amount: 500 } as any)
    expect(paid).toHaveLength(1)
  })

  it('for an AMOUNTLESS invoice the caller amount is still what counts', async () => {
    // Here the adapters DO forward request.amount, so the policy must use it.
    const { m, paid } = managerWith({ maxAmountSat: 1000 })
    await expect(m.sendPayment({ invoice: AMOUNTLESS, amount: 5000 } as any))
      .rejects.toBeInstanceOf(PolicyError)
    await m.sendPayment({ invoice: AMOUNTLESS, amount: 900 } as any)
    expect(paid).toHaveLength(1)
  })

  it('an amountless invoice with no amount is still unknown -> denied under a cap', async () => {
    const { m } = managerWith({ maxAmountSat: 1000 })
    await expect(m.sendPayment({ invoice: AMOUNTLESS } as any)).rejects.toBeInstanceOf(PolicyError)
  })

  it('with no policy configured nothing is enforced', async () => {
    const { m, paid } = managerWith(undefined)
    await m.sendPayment({ invoice: BIG_INVOICE, amount: 500 } as any)
    expect(paid).toHaveLength(1)
  })
})
