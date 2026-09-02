import { describe, it, expect } from 'vitest'
import { ProtocolManager } from '../../src/manager/ProtocolManager'
import type { IProtocolAdapter } from '../../src/adapters/IProtocolAdapter'
import type { ProtocolType } from '../../src/types/base'
import { liteBucketOf, aggregateForLite, LITE_USD } from '../../src/disclosure'
import type { UnifiedAsset } from '../../src/types/base'
import { ArkadeWdkAdapter } from '../../src/adapters/wdk/ArkadeWdkAdapter'
import { RlnWdkAdapter } from '../../src/adapters/wdk/RlnWdkAdapter'

/**
 * Task F — manager lifecycle + disclosure + escape-hatch verification tests.
 */

function stubAdapter(protocolName: ProtocolType) {
  const state = {
    connected: false,
    connectCalls: [] as { config: unknown; wasAlreadyConnected: boolean }[],
    disconnectCalls: 0,
  }
  const adapter = {
    protocolName,
    capabilities: [],
    supportedLayers: [],
    version: 'audit-stub',
    async connect(config: unknown) {
      state.connectCalls.push({ config, wasAlreadyConnected: state.connected })
      state.connected = true
    },
    async disconnect() {
      state.disconnectCalls++
      state.connected = false
    },
    isConnected: () => state.connected,
    supportsSwaps: () => false,
    async sendPayment() {
      return { paymentHash: 'ph', status: 'completed' }
    },
  }
  return { adapter: adapter as unknown as IProtocolAdapter, state }
}

describe('F6 [FIXED]: ProtocolManager.connect tears down the live adapter first', () => {
  it('a wallet switch disposes the previous session before the new connect', async () => {
    const { adapter, state } = stubAdapter('SPARK')
    const manager = new ProtocolManager()
    manager.registerAdapter(adapter)

    await manager.connect('SPARK', { protocol: 'SPARK', mnemonic: 'wallet-A' } as any)
    // Wallet switch WITHOUT an explicit disconnect — the host's normal path.
    await manager.connect('SPARK', { protocol: 'SPARK', mnemonic: 'wallet-B' } as any)

    expect(state.connectCalls).toHaveLength(2)
    // Was: `expect(state.connectCalls[1].wasAlreadyConnected).toBe(true)` and
    // `expect(state.disconnectCalls).toBe(0)`. The second connect used to enter
    // adapter.connect() while the adapter was STILL connected to wallet A, with
    // nothing disposing A's manager/account — the mechanism that made the A7
    // cross-wallet leak deterministic.
    expect(state.connectCalls[1].wasAlreadyConnected).toBe(false)
    expect(state.disconnectCalls).toBe(1)
  })

  it('sanity: an explicit disconnect between connects IS observed', async () => {
    const { adapter, state } = stubAdapter('SPARK')
    const manager = new ProtocolManager()
    manager.registerAdapter(adapter)
    await manager.connect('SPARK', { protocol: 'SPARK' })
    await manager.disconnect('SPARK')
    await manager.connect('SPARK', { protocol: 'SPARK' })
    expect(state.disconnectCalls).toBe(1)
    expect(state.connectCalls[1].wasAlreadyConnected).toBe(false)
  })
})

describe('lifecycle clean checks: teardown blocks further ops; in-flight op writes nothing', () => {
  it('operations after disconnectAll throw; a payment in flight during teardown does not resurrect state', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { adapter, state } = stubAdapter('BTC')
    adapter.sendPayment = async () => {
      await gate // payment in flight when teardown starts
      return { paymentHash: 'ph', status: 'completed' } as any
    }
    const manager = new ProtocolManager()
    manager.registerAdapter(adapter)
    await manager.connect('BTC', { protocol: 'BTC' })

    const inFlight = manager.sendPayment({ invoice: 'bc1q…', amount: 5000 })
    await manager.disconnectAll()
    release()
    await inFlight // resolves; writes nothing back into the manager

    expect(manager.getActiveProtocol()).toBeNull()
    await expect(manager.sendPayment({ invoice: 'bc1q…', amount: 1 })).rejects.toThrow(
      /No active protocol/,
    )
    expect(state.disconnectCalls).toBe(1)
  })
})

// ---------------------------------------------------------------------------

function asset(partial: Partial<UnifiedAsset> & { id: string }): UnifiedAsset {
  return {
    name: 'x',
    ticker: 'x',
    precision: 8,
    protocol: 'SPARK',
    layer: 'BTC_SPARK',
    balance: { total: 1000, available: 1000, pending: 0, locked: 0 },
    ...partial,
  } as UnifiedAsset
}

describe('M4 verification: issuer-controlled metadata cannot inflate lite BTC/USD totals', () => {
  it('scam tokens tickered BTC/USDt bucket as OTHER', () => {
    const scamBtc = asset({ id: 'btok1scam…', ticker: 'BTC', name: 'Bitcoin', layer: 'SPARK_SPARK' })
    const scamUsdt = asset({ id: 'rgb:scam', ticker: 'USDt', name: 'Tether USD', layer: 'RGB_L1' })
    expect(liteBucketOf(scamBtc)).toBe('OTHER')
    expect(liteBucketOf(scamUsdt)).toBe('OTHER')
  })

  it('spoofed decimals/precision do not move an asset into BTC or USD', () => {
    const a = asset({ id: 'btok1x', ticker: 'BTC', precision: 8, layer: 'SPARK_SPARK' })
    const { btc, usd, other } = aggregateForLite([a])
    expect(btc).toBe(0)
    expect(usd).toBe(0)
    expect(other).toHaveLength(1)
  })

  it('bucketing keys are exactly id===BTC, layer===BTC_LIQUID, id===LITE_USD.assetId', () => {
    expect(liteBucketOf(asset({ id: 'BTC', layer: 'BTC_ARKADE' }))).toBe('BTC')
    expect(liteBucketOf(asset({ id: '6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d', layer: 'BTC_LIQUID' }))).toBe('BTC')
    expect(liteBucketOf(asset({ id: LITE_USD.assetId, layer: 'LIQUID_ASSET' }))).toBe('USD')
    // A near-miss id (case / whitespace) must NOT match.
    expect(liteBucketOf(asset({ id: 'btc' }))).toBe('OTHER')
    expect(liteBucketOf(asset({ id: 'BTC ' }))).toBe('OTHER')
  })
})

// ---------------------------------------------------------------------------

describe('escape-hatch hardening checks (extends M3 verification)', () => {
  function connectedRln(account: Record<string, unknown>) {
    const adapter = new RlnWdkAdapter()
    Object.assign(adapter as any, { connected: true, account })
    return adapter
  }
  function connectedArkade(account: Record<string, unknown>) {
    const adapter = new ArkadeWdkAdapter()
    Object.assign(adapter as any, { connected: true, account })
    return adapter
  }

  it('prototype/meta members never reach the account object', async () => {
    const adapter = connectedRln({ constructor: async () => 'pwned' })
    for (const op of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'prototype']) {
      await expect(adapter.executeProtocolOperation(op, {})).rejects.toThrow(/not allowed/)
    }
  })

  it('allowlist is checked before the account is touched (account getter would throw)', async () => {
    const adapter = new RlnWdkAdapter()
    // A Poisoned account object that throws on ANY property read: if the
    // allowlist check ran after the lookup, this would throw the poison error.
    const poison = new Proxy({}, { get: () => { throw new Error('ACCOUNT TOUCHED') } })
    Object.assign(adapter as any, { connected: true, account: poison })
    await expect(adapter.executeProtocolOperation('definitely-not-allowed', {})).rejects.toThrow(/not allowed/)
  })

  it('Arkade hatch rejects the fund-moving account methods (transfer/sendTransaction)', async () => {
    const adapter = connectedArkade({
      transfer: async () => 'sent',
      sendTransaction: async () => 'sent',
    })
    await expect(adapter.executeProtocolOperation('transfer', {})).rejects.toThrow(/not allowed/)
    await expect(adapter.executeProtocolOperation('sendTransaction', {})).rejects.toThrow(/not allowed/)
  })
})

// ---------------------------------------------------------------------------

describe('F7 [FIXED]: RlnWdkAdapter.supportsSwaps() gates on makerUrl', () => {
  it('supportsSwaps() is false with NO makerUrl, so the manager gate refuses cleanly', async () => {
    const adapter = new RlnWdkAdapter() // no makerUrl configured
    // The capability must reflect what the adapter can actually do: every swap
    // call throws CONFIG without a makerUrl (RlnWdkAdapter.ts:587-589).
    expect(adapter.supportsSwaps()).toBe(false)
    Object.assign(adapter as any, { connected: true, account: {} })
    await expect(adapter.getSwapQuote({} as any)).rejects.toThrow(/makerUrl/)

    // Through the manager boundary the gate now stops the call BEFORE the
    // adapter, so the host gets NOT_SUPPORTED up front instead of a
    // configuration error surfacing mid-operation.
    const manager = new ProtocolManager()
    manager.registerAdapter(adapter as unknown as IProtocolAdapter)
    await manager.connect('RGB_LN', { protocol: 'RGB_LN' } as any).catch(() => {})
    Object.assign(manager as any, { activeProtocol: 'RGB_LN' })
    await expect(manager.getSwapQuote({} as any)).rejects.toThrow(/Swaps not supported/)
  })

  it('supportsSwaps() is true once a makerUrl is configured', () => {
    const adapter = new RlnWdkAdapter()
    Object.assign(adapter as any, { makerUrl: 'https://maker.example' })
    expect(adapter.supportsSwaps()).toBe(true)
  })

  it('parity: both RGB_LN adapters now gate supportsSwaps() on makerUrl', () => {
    // RgbAdapter.ts: `return !!this.config?.makerUrl` — the WDK adapter now has
    // an equivalent override rather than inheriting the static manifest flag.
    expect((RlnWdkAdapter as any).prototype.hasOwnProperty('supportsSwaps')).toBe(true)
  })
})

describe('F8: ARKADE declares lightning-receive but core createInvoice returns an Ark address', () => {
  it('createInvoice resolves to a plain Ark address, not a BOLT11 invoice', async () => {
    const adapter = new ArkadeWdkAdapter()
    Object.assign(adapter as any, {
      connected: true,
      account: { getAddress: async () => 'ark1qreceiver…' },
    })
    const inv = await adapter.createInvoice({ amount: 5000 })
    expect(inv.invoice).toBe('ark1qreceiver…') // NOT lnbc…
    expect(inv.invoice.startsWith('ln')).toBe(false)
    // The actual Lightning path exists on the optional-group method
    // createArkadeLightningInvoice (ArkadeWdkAdapter.ts).
    expect(typeof (adapter as any).createArkadeLightningInvoice).toBe('function')
  })

  it('[FIXED] a BTC_LN request honours InvoiceRequest.layer and returns a bolt11', async () => {
    const adapter = new ArkadeWdkAdapter()
    Object.assign(adapter as any, {
      connected: true,
      account: {
        getAddress: async () => 'ark1qreceiver…',
        createLightningInvoice: async (amount: number) => ({
          invoice: `lnbc${amount}1pboltz`,
          paymentHash: 'ph-boltz',
        }),
      },
    })
    const inv = await adapter.createInvoice({ amount: 5000, layer: 'BTC_LN' })
    // ARKADE declares `lightning-receive`; a caller asking for that layer must not
    // get an Ark address a host would render as a Lightning QR.
    expect(inv.invoice.startsWith('lnbc')).toBe(true)
    expect(inv.paymentHash).toBe('ph-boltz')
  })

  it('[FIXED] a request with no layer still returns the Ark address (unchanged default)', async () => {
    const adapter = new ArkadeWdkAdapter()
    Object.assign(adapter as any, {
      connected: true,
      account: { getAddress: async () => 'ark1qreceiver…' },
    })
    expect((await adapter.createInvoice({ amount: 5000 })).invoice).toBe('ark1qreceiver…')
  })
})
