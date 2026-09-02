import { describe, expect, it } from 'vitest'
import { registerWdkModule } from '../../src/adapters/wdk/moduleLoader'
import { KaleidoswapSwap } from '../../src/swap/KaleidoswapSwap'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('N6: Kaleidoswap protocol construction is single-flight', () => {
  it('shares one explicitly interleaved first module load and constructor', async () => {
    const gate = deferred<void>()
    let loads = 0
    let constructions = 0
    class FakeProtocol {
      constructor() { constructions++ }
      async quoteSwap() {
        return { rfqId: 'q', tokenInAmount: 1, tokenOutAmount: 1, price: 1, fee: 0, expiresAt: 1 }
      }
    }
    registerWdkModule('@kaleidorg/wdk-protocol-swap-kaleidoswap', async () => {
      loads++
      await gate.promise
      return { default: FakeProtocol }
    })

    const swap = new KaleidoswapSwap({}, { baseUrl: 'https://maker.example' })
    const request = {
      fromAsset: 'BTC', toAsset: 'RGB', fromAmount: 1,
      fromLayer: 'BTC_LN', toLayer: 'RGB_LN',
    } as never
    const first = swap.getQuote(request)
    const second = swap.getQuote(request)
    gate.resolve()
    await Promise.all([first, second])

    expect(loads).toBe(1)
    expect(constructions).toBe(1)
  })
})
