import { describe, expect, it } from 'vitest'
import { convertTokenTransactionToUnified } from '../../src/lib/spark-converters'
import { rawTokenIdFromBytes } from '../../src/lib/spark-helpers'

describe('E-F5: Spark token amounts fail closed beyond Number precision', () => {
  it('rejects a u128 amount of 2^53+1 instead of rounding it down', () => {
    const tokenId = new Uint8Array(32).fill(4)
    const amountBytes = new Uint8Array(16)
    new DataView(amountBytes.buffer).setBigUint64(8, 2n ** 53n + 1n, false)
    const owner = new Uint8Array(33).fill(1)
    const tx = {
      tokenTransaction: {
        tokenOutputs: [{ ownerPublicKey: owner, tokenIdentifier: tokenId, tokenAmount: amountBytes }],
        tokenInputs: { $case: 'mintInput' },
      },
      status: 2,
      tokenTransactionHash: new Uint8Array(32).fill(3),
    }
    const ownerHex = Array.from(owner, (b) => b.toString(16).padStart(2, '0')).join('')
    const metadata = new Map([[
      rawTokenIdFromBytes(tokenId),
      { id: 'btkn1x', meta: { name: 'Big', ticker: 'BIG', decimals: 0 } },
    ]])

    expect(() => convertTokenTransactionToUnified(
      tx, ownerHex, new Map(), metadata, new Set(), new Map(), new Map(), 'MAINNET',
    )).toThrow(/safe integer/i)
  })
})
