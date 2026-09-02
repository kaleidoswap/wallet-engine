import { describe, it, expect } from 'vitest'
import { ProtocolManager } from '../../src/manager/ProtocolManager'
import { evaluatePolicy, PolicyError, type SigningPolicy } from '../../src/policy'
import { CrossProtocolRouter } from '../../src/router'
import { ProtocolAdapterRegistry, type IProtocolAdapter } from '../../src/adapters/IProtocolAdapter'
import { protocolSupportsOperation } from '../../src/capabilities/operations'
import { decodeBolt11 } from '../../src/lib/bolt11'
import { LiquidWdkAdapter } from '../../src/adapters/wdk/LiquidWdkAdapter'
import { RlnWdkAdapter } from '../../src/adapters/wdk/RlnWdkAdapter'
import type { PaymentRequest, ProtocolType, Quote } from '../../src/types/base'

/**
 * Task F audit verification tests.
 * Each stub mirrors REAL adapter behaviour cited in the findings file.
 */

/** Minimal connected stub adapter. `sendPayment` mimics SparkAdapter.ts:695-696 and
 *  RlnWdkAdapter.ts:331: the explicit `request.amount` is only forwarded for
 *  AMOUNTLESS invoices — an amount-bearing invoice is paid at the invoice amount. */
function stubAdapter(protocolName: ProtocolType, opts: { swaps?: boolean } = {}) {
  const state = {
    connected: false,
    paidInvoiceAmountSat: undefined as number | undefined,
    swapsExecuted: [] as Quote[],
    psbtsSigned: [] as string[],
  }
  const adapter = {
    protocolName,
    capabilities: [],
    supportedLayers: [],
    version: 'audit-stub',
    async connect() { state.connected = true },
    async disconnect() { state.connected = false },
    isConnected: () => state.connected,
    supportsSwaps: () => opts.swaps === true,
    async sendPayment(request: PaymentRequest) {
      // Real-adapter semantics: invoice amount wins when the invoice encodes one.
      const invoiceAmount = decodeBolt11(request.invoice).amountSat
      state.paidInvoiceAmountSat = invoiceAmount ?? request.amount
      return { paymentHash: 'ph', status: 'completed' }
    },
    async getSwapQuote() { return {} },
    async executeSwap(quote: Quote) {
      state.swapsExecuted.push(quote)
      return { swapId: 'sw', status: 'completed', quote, timestamp: 0 }
    },
    async signPsbt(psbtHex: string) {
      state.psbtsSigned.push(psbtHex)
      return { psbt: psbtHex, unchanged: false }
    },
  }
  return { adapter: adapter as unknown as IProtocolAdapter, state }
}

// BOLT11 HRP encoding 0.01 BTC = 1,000,000 sats ('lnbc' + '10' + 'm' + '1').
const INVOICE_1M_SATS = 'lnbc10m1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq'

describe('F1: policy checks caller amount, adapter pays invoice amount', () => {
  it('[FIXED] amount-bearing invoice + small explicit amount no longer bypasses maxAmountSat', async () => {
    const { adapter, state } = stubAdapter('SPARK')
    const manager = new ProtocolManager({ policy: { maxAmountSat: 1000 } })
    manager.registerAdapter(adapter)
    await manager.connect('SPARK', { protocol: 'SPARK' })

    // Deep-link style request: invoice encodes 1,000,000 sats, amount says 500.
    // FIXED (audit finding F-F1): the policy now evaluates the invoice amount,
    // which is what the adapters actually pay.
    await expect(manager.sendPayment({ invoice: INVOICE_1M_SATS, amount: 500 })).rejects.toThrow(PolicyError)
    expect(state.paidInvoiceAmountSat).toBeUndefined()
  })

  it('without the explicit amount the same invoice is correctly denied', async () => {
    const { adapter } = stubAdapter('SPARK')
    const manager = new ProtocolManager({ policy: { maxAmountSat: 1000 } })
    manager.registerAdapter(adapter)
    await manager.connect('SPARK', { protocol: 'SPARK' })
    await expect(manager.sendPayment({ invoice: INVOICE_1M_SATS })).rejects.toThrow(PolicyError)
  })
})

describe('F2 [FIXED]: swap caps no longer compare sats against raw asset base units', () => {
  const xautQuote: Quote = {
    id: 'q1', fromAsset: 'XAUT', fromAmount: 90_000, // 0.9 XAUT at precision 6
    toAsset: 'BTC', toAmount: 8_000_000, price: 0, fee: { amount: 0, asset: 'XAUT' }, expiresAt: 0,
  }
  it('a ~$3k XAUT swap no longer passes a 100k-sat cap on a numeric coincidence', async () => {
    const { adapter, state } = stubAdapter('RGB_LN', { swaps: true })
    const manager = new ProtocolManager({ policy: { maxAmountSat: 100_000 } })
    manager.registerAdapter(adapter)
    await manager.connect('RGB_LN', { protocol: 'RGB_LN' })

    // The from-asset is not BTC, so `fromAmount` is not sats and the cap cannot
    // bound it. The policy engine's fail-closed AMOUNT_UNKNOWN rule applies.
    await expect(manager.executeSwap(xautQuote)).rejects.toThrow(PolicyError)
    expect(state.swapsExecuted).toHaveLength(0)
  })

  it('with no cap configured, an asset swap still executes', async () => {
    const { adapter, state } = stubAdapter('RGB_LN', { swaps: true })
    const manager = new ProtocolManager({ policy: {} })
    manager.registerAdapter(adapter)
    await manager.connect('RGB_LN', { protocol: 'RGB_LN' })

    await manager.executeSwap(xautQuote)
    expect(state.swapsExecuted).toHaveLength(1)
  })

  it('a BTC-denominated quote UNDER the cap still executes', async () => {
    const { adapter, state } = stubAdapter('RGB_LN', { swaps: true })
    const manager = new ProtocolManager({ policy: { maxAmountSat: 100_000 } })
    manager.registerAdapter(adapter)
    await manager.connect('RGB_LN', { protocol: 'RGB_LN' })

    await manager.executeSwap({ ...xautQuote, fromAsset: 'BTC', fromAmount: 50_000 })
    expect(state.swapsExecuted).toHaveLength(1)
  })

  it('sanity: a BTC-denominated quote over the cap IS denied', async () => {
    const { adapter, state } = stubAdapter('RGB_LN', { swaps: true })
    const manager = new ProtocolManager({ policy: { maxAmountSat: 100_000 } })
    manager.registerAdapter(adapter)
    await manager.connect('RGB_LN', { protocol: 'RGB_LN' })
    await expect(
      manager.executeSwap({ ...xautQuote, fromAsset: 'BTC', fromAmount: 900_000 }),
    ).rejects.toThrow(PolicyError)
    expect(state.swapsExecuted).toHaveLength(0)
  })
})

describe('F3: CrossProtocolRouter route objects carry live raw adapters', () => {
  it('route.adapter.sendPayment runs while the same op is policy-denied via the manager', async () => {
    const { adapter, state } = stubAdapter('SPARK')
    const manager = new ProtocolManager({ policy: { mode: 'deny' } }) // no grants → deny everything
    manager.registerAdapter(adapter)
    await manager.connect('SPARK', { protocol: 'SPARK' })

    // 1. Manager boundary: denied.
    await expect(manager.sendPayment({ invoice: INVOICE_1M_SATS })).rejects.toThrow(PolicyError)
    // 2. Manager raw-access gate: denied.
    expect(() => manager.getAdapter('SPARK')).toThrow(/Raw adapter access is disabled/)
    // 3. Router (same adapter instance, the standard integration) hands it out in a route.
    const registry = new ProtocolAdapterRegistry()
    registry.register(adapter)
    const router = new CrossProtocolRouter(registry)
    const route = router.resolveSend(INVOICE_1M_SATS).best
    expect(route).not.toBeNull()
    await route!.adapter.sendPayment({ invoice: INVOICE_1M_SATS }) // zero policy evaluation
    expect(state.paidInvoiceAmountSat).toBe(1_000_000)
  })
})

describe('F4: signing ops evade all spend caps', () => {
  const policy: SigningPolicy = {
    mode: 'deny',
    maxAmountSat: 1000,
    grants: [{ id: 'g', operations: ['signPsbt'] }],
  }
  it('evaluatePolicy allows signPsbt under a 1000-sat global cap', () => {
    const d = evaluatePolicy({ operation: 'signPsbt', grantId: 'g' }, policy)
    expect(d.allowed).toBe(true)
  })
  it('manager.signPsbt signs under the same capped, default-deny policy', async () => {
    const { adapter, state } = stubAdapter('SPARK')
    const manager = new ProtocolManager({ policy })
    manager.registerAdapter(adapter)
    await manager.connect('SPARK', { protocol: 'SPARK' })
    manager.setActiveGrant('g')
    // A drain PSBT: no amount is ever extracted or compared against the cap.
    await manager.signPsbt('70736274ff') // policy passes, adapter signs
    expect(state.psbtsSigned).toEqual(['70736274ff'])
  })
})

describe('F5 [FIXED ON main]: LIQUID manifest no longer declares PSET ops the adapter may not have', () => {
  // Run 1 reproduced this as "the static manifest says yes while the adapter
  // throws". `main` closed it in 0ce6304 ("fix(liquid): fail closed on
  // unsupported PSET operations") by dropping the experimental ops from the
  // static manifest and deriving them per-account from the resolved LWK
  // binding. Asserting the FIXED property here, not the old defect.
  it('the static manifest no longer advertises the experimental ops', () => {
    expect(protocolSupportsOperation('LIQUID', 'liquid-pset-sign')).toBe(false)
    expect(protocolSupportsOperation('LIQUID', 'simplicity-compile')).toBe(false)
    // Base Liquid operations are unaffected.
    expect(protocolSupportsOperation('LIQUID', 'onchain-send')).toBe(true)
  })

  it('a build without the experimental methods advertises neither and still refuses', async () => {
    const adapter = new LiquidWdkAdapter()
    Object.assign(adapter as any, { connected: true, account: {} }) // build without experimental methods
    expect(adapter.capabilities).not.toContain('liquid-pset-sign')
    expect(adapter.capabilities).not.toContain('simplicity-compile')
    await expect(adapter.getSimplicityCapabilities()).resolves.toMatchObject({ available: false })
    await expect(
      adapter.signLiquidPset({ pset: 'AAAA' } as any),
    ).rejects.toThrow(/Simplicity-capable/)
  })

  it('a Simplicity-capable binding is what makes the flag appear', () => {
    const adapter = new LiquidWdkAdapter()
    Object.assign(adapter as any, {
      connected: true,
      account: {
        getSimplicityCapabilities: () => ({
          available: true,
          pset: { inspect: true, sign: true },
          simplicity: { compile: true },
        }),
      },
    })
    expect(adapter.capabilities).toContain('liquid-pset-sign')
    expect(adapter.capabilities).toContain('simplicity-compile')
  })
})

describe('M3 escape-hatch verification (confirmed sound)', () => {
  function connectedRln() {
    const adapter = new RlnWdkAdapter()
    Object.assign(adapter as any, { connected: true, account: { keysend: async () => 'paid' } })
    return adapter
  }
  it('is case-sensitive: KeySend does not reach the keysend block', async () => {
    const adapter = connectedRln()
    await expect(adapter.executeProtocolOperation('KeySend', {})).rejects.toThrow(/not allowed/i)
  })
  it('rejects numeric / symbol operation keys', async () => {
    const adapter = connectedRln()
    await expect(adapter.executeProtocolOperation(0 as any, {})).rejects.toThrow(/not allowed/i)
    // A Symbol key is also rejected — Set.has returns false; the error message just
    // differs (TypeError from the template literal), it never reaches the account.
    await expect(adapter.executeProtocolOperation(Symbol('keysend') as any, {})).rejects.toThrow()
  })
  it('every fund-moving op named in the commit is in the privileged set', async () => {
    const adapter = connectedRln()
    for (const op of ['keysend', 'openChannel', 'closeChannel', 'createUtxos', 'whitelistSwap', 'atomicTaker', 'makerInit', 'makerExecute', 'backup']) {
      await expect(adapter.executeProtocolOperation(op, {})).rejects.toThrow(/allowPrivilegedOps/i)
    }
  })
})
