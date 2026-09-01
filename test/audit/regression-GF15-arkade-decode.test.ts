import { describe, expect, it } from 'vitest'
import { ArkadeAdapter } from '../../src/adapters/ArkadeAdapter'

describe('G-F15 residual: Arkade decodeInvoice fails closed', () => {
  it.each(['not-an-invoice', 'lnbc1not-a-valid-checksummed-invoice'])(
    'rejects an input it cannot decode: %s',
    async (input) => {
      await expect(new ArkadeAdapter().decodeInvoice(input)).rejects.toMatchObject({
        code: 'INVALID_INVOICE',
      })
    },
  )
})
