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

  it('routes review and compilation through the active adapter', async () => {
    const manager = new ProtocolManager({ defaultProtocol: 'BTC' })
    manager.registerAdapter(simplicityAdapter())
    await expect(manager.getSimplicityCapabilities()).resolves.toEqual(capabilities)
    await expect(manager.compileSimplicityProgram({ source: 'main := unit' }))
      .resolves.toEqual(expect.objectContaining({ cmr: 'cmr', address: 'address' }))
  })

  it('publishes static Liquid capabilities for review, signing, and compilation', () => {
    expect(PROTOCOL_OPERATIONS.LIQUID).toEqual(expect.arrayContaining([
      'liquid-pset-inspect',
      'liquid-pset-sign',
      'simplicity-compile',
    ]))
  })

  it('rejects routing when the active adapter does not implement the complete group', async () => {
    const manager = new ProtocolManager({ defaultProtocol: 'BTC' })
    manager.registerAdapter(new MemoAdapter())
    await expect(manager.inspectLiquidPset('external')).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      protocol: 'BTC',
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
        grants: [{ id: 'contract-ui', operations: ['signLiquidPset'], protocols: ['BTC'] }],
      },
    })
    manager.registerAdapter(adapter)
    manager.setActiveGrant('contract-ui')
    await expect(manager.signLiquidPset({ pset: 'external', inputIndexes: [0] }))
      .resolves.toMatchObject({ pset: 'signed:external', signedInputIndexes: [0] })
    expect(adapter.signLiquidPset).toHaveBeenCalledOnce()
  })
})
