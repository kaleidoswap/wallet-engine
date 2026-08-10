import { describe, expect, it, vi } from 'vitest'
import { asSimplicityOperations, type IProtocolAdapter } from '../src/adapters/IProtocolAdapter'
import { ProtocolManager } from '../src/manager/ProtocolManager'
import { PolicyError } from '../src/policy'
import { MemoAdapter } from '../examples/minimal-adapter/MemoAdapter'
import { PROTOCOL_OPERATIONS } from '../src/capabilities/operations'

const capabilities = {
  version: 'experimental-0.1' as const,
  available: true,
  pset: { inspect: true, blind: true, sign: true, finalize: true },
  simplicity: { compile: true, derivePublicKey: true, finalizeTransaction: true },
}

function simplicityAdapter() {
  return Object.assign(new MemoAdapter(), {
    protocolName: 'LIQUID',
    getSimplicityCapabilities: async () => capabilities,
    inspectLiquidPset: async (pset: string) => ({ pset, uniqueId: 'id' }),
    blindLiquidPset: async (pset: string) => `blind:${pset}`,
    signLiquidPset: vi.fn(async ({ pset }: { pset: string }) => ({
      pset: `signed:${pset}`,
      signedInputIndexes: [0],
      unchanged: false,
    })),
    finalizeLiquidPset: async (pset: string) => ({ pset, transactionHex: '00', txid: 'txid' }),
    broadcastLiquidPset: async () => ({ txid: 'txid' }),
    deriveSimplicityPublicKey: async () => ({ publicKey: 'key', derivationPath: 'm/0' }),
    compileSimplicityProgram: async () => ({
      cmr: 'cmr',
      address: 'address',
      internalKey: 'internal',
      walletPublicKey: 'wallet',
      derivationPath: 'm/0',
    }),
  }) as unknown as IProtocolAdapter
}

describe('Simplicity capability routing', () => {
  it('narrows only a complete Simplicity operation group', () => {
    expect(asSimplicityOperations(simplicityAdapter())).not.toBeNull()
    expect(asSimplicityOperations(Object.assign(new MemoAdapter(), {
      inspectLiquidPset: async () => ({}),
    }) as unknown as IProtocolAdapter)).toBeNull()
  })

  it('routes review and compilation to the registered LIQUID adapter', async () => {
    const manager = new ProtocolManager({ defaultProtocol: 'BTC' })
    manager.registerAdapter(simplicityAdapter())
    await expect(manager.getSimplicityCapabilities()).resolves.toEqual(capabilities)
    await expect(manager.compileSimplicityProgram({ source: 'main := unit' }))
      .resolves.toEqual(expect.objectContaining({ cmr: 'cmr', address: 'address' }))
  })

  it('keeps experimental PSET/Simplicity operations out of the static Liquid manifest (runtime-derived)', () => {
    // Only the always-on Liquid operations are static; PSET/Simplicity support
    // is advertised by LiquidWdkAdapter at runtime from getSimplicityCapabilities().
    expect(PROTOCOL_OPERATIONS.LIQUID).toEqual(
      expect.arrayContaining(['onchain-send', 'onchain-receive', 'asset-send', 'asset-receive']),
    )
    expect(PROTOCOL_OPERATIONS.LIQUID).not.toContain('liquid-pset-inspect')
    expect(PROTOCOL_OPERATIONS.LIQUID).not.toContain('liquid-pset-sign')
    expect(PROTOCOL_OPERATIONS.LIQUID).not.toContain('simplicity-compile')
  })

  it('rejects routing when the registered LIQUID adapter does not implement the complete group', async () => {
    const manager = new ProtocolManager({ defaultProtocol: 'BTC' })
    // A LIQUID adapter that implements only part of the Simplicity group.
    manager.registerAdapter(
      Object.assign(new MemoAdapter(), {
        protocolName: 'LIQUID',
        inspectLiquidPset: async () => ({ pset: '', uniqueId: '' }),
      }) as unknown as IProtocolAdapter,
    )
    await expect(manager.inspectLiquidPset('external')).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      protocol: 'LIQUID',
    })
  })

  it('policy-gates PSET signing before calling the adapter', async () => {
    const adapter = simplicityAdapter()
    const manager = new ProtocolManager({ defaultProtocol: 'BTC', policy: { mode: 'deny' } })
    manager.registerAdapter(adapter)
    await expect(manager.signLiquidPset({ pset: 'external', inputIndexes: [0] }))
      .rejects.toBeInstanceOf(PolicyError)
    expect(adapter.signLiquidPset).not.toHaveBeenCalled()
  })

  it('allows PSET signing only after activating a matching grant', async () => {
    const adapter = simplicityAdapter()
    const manager = new ProtocolManager({
      defaultProtocol: 'BTC',
      policy: {
        mode: 'deny',
        grants: [{ id: 'contract-ui', operations: ['signLiquidPset'], protocols: ['LIQUID'] }],
      },
    })
    manager.registerAdapter(adapter)
    manager.setActiveGrant('contract-ui')
    await expect(manager.signLiquidPset({ pset: 'external', inputIndexes: [0] }))
      .resolves.toMatchObject({ pset: 'signed:external', signedInputIndexes: [0] })
    expect(adapter.signLiquidPset).toHaveBeenCalledOnce()
  })
})

/**
 * Fail-closed guarantees for the Liquid PSET manager routes. Until an exact-byte
 * `LiquidSpendAuthorization` contract exists, finalize/broadcast must never reach
 * the adapter; every mutation (blind/sign) must pass the policy gate; and all
 * Liquid PSET operations must route to the *registered LIQUID adapter*, never to
 * whichever protocol happens to be active.
 */
describe('ProtocolManager Liquid PSET fail-closed + routing', () => {
  function liquidAdapter(overrides: Record<string, unknown> = {}) {
    return Object.assign(new MemoAdapter(), {
      protocolName: 'LIQUID',
      getSimplicityCapabilities: async () => capabilities,
      inspectLiquidPset: vi.fn(async (pset: string) => ({ pset, uniqueId: 'liquid' })),
      blindLiquidPset: vi.fn(async (pset: string) => `blind:${pset}`),
      signLiquidPset: vi.fn(async ({ pset }: { pset: string }) => ({
        pset: `signed:${pset}`,
        signedInputIndexes: [0],
        unchanged: false,
      })),
      finalizeLiquidPset: vi.fn(async (pset: string) => ({ pset, transactionHex: '00', txid: 'txid' })),
      broadcastLiquidPset: vi.fn(async () => ({ txid: 'txid' })),
      deriveSimplicityPublicKey: vi.fn(async () => ({ publicKey: 'key', derivationPath: 'm/0' })),
      compileSimplicityProgram: vi.fn(async () => ({
        cmr: 'cmr',
        address: 'address',
        internalKey: 'internal',
        walletPublicKey: 'wallet',
        derivationPath: 'm/0',
      })),
      ...overrides,
    }) as unknown as IProtocolAdapter
  }

  it('fails closed on finalizeLiquidPset without reaching the adapter', async () => {
    const adapter = liquidAdapter()
    const m = new ProtocolManager({ defaultProtocol: 'LIQUID' })
    m.registerAdapter(adapter)
    await expect(m.finalizeLiquidPset('pset')).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      protocol: 'LIQUID',
    })
    expect(adapter.finalizeLiquidPset).not.toHaveBeenCalled()
  })

  it('fails closed on broadcastLiquidPset without reaching the adapter', async () => {
    const adapter = liquidAdapter()
    const m = new ProtocolManager({ defaultProtocol: 'LIQUID' })
    m.registerAdapter(adapter)
    await expect(m.broadcastLiquidPset('pset')).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      protocol: 'LIQUID',
    })
    expect(adapter.broadcastLiquidPset).not.toHaveBeenCalled()
  })

  it('policy-gates blindLiquidPset before it reaches the adapter', async () => {
    const adapter = liquidAdapter()
    const m = new ProtocolManager({ defaultProtocol: 'LIQUID', policy: { mode: 'deny' } })
    m.registerAdapter(adapter)
    await expect(m.blindLiquidPset('pset')).rejects.toBeInstanceOf(PolicyError)
    expect(adapter.blindLiquidPset).not.toHaveBeenCalled()
  })

  it('allows blindLiquidPset only under a matching Liquid grant', async () => {
    const adapter = liquidAdapter()
    const m = new ProtocolManager({
      defaultProtocol: 'LIQUID',
      policy: {
        mode: 'deny',
        grants: [{ id: 'contract-ui', operations: ['blindLiquidPset'], protocols: ['LIQUID'] }],
      },
    })
    m.registerAdapter(adapter)
    m.setActiveGrant('contract-ui')
    await expect(m.blindLiquidPset('pset')).resolves.toBe('blind:pset')
    expect(adapter.blindLiquidPset).toHaveBeenCalledOnce()
  })

  it('routes Liquid PSET operations to the LIQUID adapter, not the active protocol', async () => {
    const liquid = liquidAdapter()
    const active = Object.assign(new MemoAdapter(), {
      protocolName: 'SPARK',
      getSimplicityCapabilities: async () => capabilities,
      inspectLiquidPset: vi.fn(async (pset: string) => ({ pset, uniqueId: 'active-wrong' })),
      blindLiquidPset: vi.fn(async () => 'active-wrong'),
      signLiquidPset: vi.fn(async () => ({ pset: 'active-wrong', signedInputIndexes: [], unchanged: true })),
      finalizeLiquidPset: vi.fn(async () => ({ pset: 'active-wrong', transactionHex: '', txid: 'active-wrong' })),
      broadcastLiquidPset: vi.fn(async () => ({ txid: 'active-wrong' })),
      deriveSimplicityPublicKey: vi.fn(async () => ({ publicKey: 'active-wrong', derivationPath: 'm/0' })),
      compileSimplicityProgram: vi.fn(async () => ({
        cmr: 'active-wrong',
        address: 'active-wrong',
        internalKey: 'x',
        walletPublicKey: 'x',
        derivationPath: 'm/0',
      })),
    }) as unknown as IProtocolAdapter
    const m = new ProtocolManager({ defaultProtocol: 'SPARK' })
    m.registerAdapter(active)
    m.registerAdapter(liquid)
    await expect(m.inspectLiquidPset('x')).resolves.toMatchObject({ uniqueId: 'liquid' })
    expect(liquid.inspectLiquidPset).toHaveBeenCalledOnce()
    expect(active.inspectLiquidPset).not.toHaveBeenCalled()
  })

  it('rejects Liquid PSET operations when no LIQUID adapter is registered', async () => {
    const m = new ProtocolManager({ defaultProtocol: 'BTC' })
    m.registerAdapter(new MemoAdapter())
    await expect(m.inspectLiquidPset('x')).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      protocol: 'LIQUID',
    })
  })
})
