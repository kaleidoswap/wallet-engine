import { describe, it, expect, vi } from 'vitest'
import { ProtocolManager } from '../src/manager/ProtocolManager'
import { PolicyError, type SigningPolicy } from '../src/policy'
import { MemoAdapter } from '../examples/minimal-adapter/MemoAdapter'

/**
 * ProtocolManager gates fund-moving ops through the policy when one is configured,
 * and is fully backward-compatible when it is not.
 */
async function managerWith(policy?: SigningPolicy) {
  const m = new ProtocolManager({ defaultProtocol: 'BTC', policy })
  m.registerAdapter(new MemoAdapter())
  await m.connect('BTC', { protocol: 'BTC' })
  return m
}

describe('ProtocolManager policy enforcement', () => {
  it('no policy → sends proceed unchanged (backward-compatible)', async () => {
    const m = await managerWith(undefined)
    const r = await m.sendPayment({ invoice: 'lnbc1x', amount: 10_000 })
    expect(r.status).toBe('confirmed')
  })

  it('global cap blocks an over-limit send before it reaches the adapter', async () => {
    const m = await managerWith({ maxAmountSat: 1000 })
    await expect(m.sendPayment({ invoice: 'lnbc1x', amount: 5000 })).rejects.toBeInstanceOf(PolicyError)
    // under the cap still works
    await expect(m.sendPayment({ invoice: 'lnbc1x', amount: 500 })).resolves.toMatchObject({
      status: 'confirmed',
    })
  })

  it('enforces the cap against the invoice amount when no explicit amount is given (M1)', async () => {
    const m = await managerWith({ maxAmountSat: 1000 })
    // lnbc20u = 2000 sats, encoded in the invoice, no request.amount → previously
    // slipped past the cap; now decoded and blocked.
    await expect(m.sendPayment({ invoice: 'lnbc20u1qqq' })).rejects.toMatchObject({
      code: 'AMOUNT_OVER_GLOBAL_LIMIT',
    })
    // lnbc10u = 1000 sats, at the cap → allowed
    await expect(m.sendPayment({ invoice: 'lnbc10u1qqq' })).resolves.toMatchObject({
      status: 'confirmed',
    })
  })

  it('denies a truly amountless invoice when a cap is set (fail closed)', async () => {
    const m = await managerWith({ maxAmountSat: 1000 })
    await expect(m.sendPayment({ invoice: 'lnbc1qqq' })).rejects.toMatchObject({
      code: 'AMOUNT_UNKNOWN',
    })
  })

  it('allows an amountless invoice when no cap is configured', async () => {
    const m = await managerWith({ mode: 'allow' })
    await expect(m.sendPayment({ invoice: 'lnbc1qqq' })).resolves.toMatchObject({
      status: 'confirmed',
    })
  })

  it('default-deny blocks until the matching grant is active', async () => {
    const policy: SigningPolicy = {
      mode: 'deny',
      grants: [{ id: 'app', operations: ['send'], protocols: ['BTC'], maxAmountSat: 2000 }],
    }
    const m = await managerWith(policy)

    // no active grant → denied
    await expect(m.sendPayment({ invoice: 'lnbc1x', amount: 100 })).rejects.toMatchObject({
      code: 'NO_GRANT',
    })

    m.setActiveGrant('app')
    await expect(m.sendPayment({ invoice: 'lnbc1x', amount: 100 })).resolves.toMatchObject({
      status: 'confirmed',
    })
    // grant cap still enforced
    await expect(m.sendPayment({ invoice: 'lnbc1x', amount: 2001 })).rejects.toMatchObject({
      code: 'AMOUNT_OVER_GRANT_LIMIT',
    })

    // clearing the grant re-locks
    m.setActiveGrant(null)
    await expect(m.sendPayment({ invoice: 'lnbc1x', amount: 100 })).rejects.toMatchObject({
      code: 'NO_GRANT',
    })
  })

  it('blocks raw adapter access by default when policy enforcement is active', async () => {
    const m = await managerWith({ mode: 'deny' })
    expect(() => m.getActiveAdapter()).toThrow(/raw adapter access is disabled/i)
    expect(() => m.getAdapter('BTC')).toThrow(/raw adapter access is disabled/i)
  })

  it('allows an explicit trusted-host opt-in to raw adapters', async () => {
    const m = new ProtocolManager({
      defaultProtocol: 'BTC',
      policy: { mode: 'deny' },
      allowUnsafeAdapterAccess: true,
    })
    m.registerAdapter(new MemoAdapter())
    await m.connect('BTC', { protocol: 'BTC' })
    expect(m.getActiveAdapter().protocolName).toBe('BTC')
  })

  it('policy-gates PSBT signing through ProtocolManager', async () => {
    const signPsbt = vi.fn(async (psbt: string) => ({ psbt: `${psbt}-signed`, unchanged: false }))
    const adapter = new MemoAdapter()
    Object.assign(adapter, {
      signPsbt,
    })
    const m = new ProtocolManager({
      defaultProtocol: 'BTC',
      policy: { mode: 'deny', grants: [{ id: 'app', operations: ['signPsbt'] }] },
    })
    m.registerAdapter(adapter)
    await m.connect('BTC', { protocol: 'BTC' })

    await expect(m.signPsbt('psbt')).rejects.toMatchObject({ code: 'NO_GRANT' })
    expect(signPsbt).not.toHaveBeenCalled()

    m.setActiveGrant('app')
    await expect(m.signPsbt('psbt')).resolves.toEqual({
      psbt: 'psbt-signed',
      unchanged: false,
    })
  })
})
