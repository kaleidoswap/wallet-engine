import { describe, it, expect } from 'vitest'
import {
  asRgbOperations,
  asSwapOperations,
  asSigningOperations,
  asSparkOperations,
  type IProtocolAdapter,
  type ICoreProtocolAdapter,
  type IRgbOperations,
} from '../src/adapters/IProtocolAdapter'
import { MemoAdapter } from '../examples/minimal-adapter/MemoAdapter'

/**
 * The contract decomposition (Core + Partial<capability groups>) must stay
 * structurally identical to the historical flat interface, and the narrowing
 * helpers must gate on actual method presence.
 */
describe('IProtocolAdapter decomposition', () => {
  it('a core-only adapter satisfies IProtocolAdapter and narrows to no groups', () => {
    // MemoAdapter implements only the universal surface — no RGB/Spark/swap methods.
    const memo: IProtocolAdapter = new MemoAdapter()
    // Compiles ⇒ core-only is assignable to the composed contract.
    const _core: ICoreProtocolAdapter = memo
    expect(_core.protocolName).toBe('BTC')

    expect(asRgbOperations(memo)).toBeNull()
    expect(asSigningOperations(memo)).toBeNull()
    expect(asSparkOperations(memo)).toBeNull()
    expect(asSwapOperations(memo)).toBeNull() // supportsSwaps() === false
  })

  it('narrows to a group when the adapter implements its methods', () => {
    const rgbish = {
      ...new MemoAdapter(),
      createRgbInvoice: async () => ({}),
      sendAsset: async () => ({}),
    } as unknown as IProtocolAdapter

    const rgb = asRgbOperations(rgbish)
    expect(rgb).not.toBeNull()
    // The narrowed handle is typed as IRgbOperations.
    const typed: IRgbOperations = rgb!
    expect(typeof typed.createRgbInvoice).toBe('function')
  })

  it('asSwapOperations requires BOTH supportsSwaps() and the swap methods', () => {
    // supportsSwaps true but methods missing ⇒ null (no partial narrowing).
    const claimsButLacks = { supportsSwaps: () => true } as unknown as IProtocolAdapter
    expect(asSwapOperations(claimsButLacks)).toBeNull()
  })
})
