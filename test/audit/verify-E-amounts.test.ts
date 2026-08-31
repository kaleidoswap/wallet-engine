import { describe, it, expect } from 'vitest'
import { formatAmount } from '../../src/lib/amount'
import { convertSdkBalance, convertTransferToTransaction, convertPaymentToTransaction } from '../../src/lib/rgb-converters'
import { decodeBolt11 } from '../../src/lib/bolt11'

describe('VERIFY E-F1: formatAmount float division + toFixed range', () => {
  it('[E-F1b FIXED] precision > 100 renders instead of throwing RangeError', () => {
    let err: any = null
    let out = ''
    try { out = formatAmount(5, 200) } catch (e: any) { err = e }
    console.log('formatAmount(5,200) ->', err ? `${err.constructor.name}: ${err.message}` : out)
    expect(err).toBeNull()
    expect(out).toBe('0.' + '0'.repeat(199) + '5')
  })
  it('precision 18 on a large integer', () => {
    // BigInt truth vs float result
    const raw = 999999999999999999n
    const float = formatAmount(Number(raw), 18)
    console.log('formatAmount(999999999999999999, 18) =', float, '| BigInt truth = 0.999999999999999999')
    console.log('NOTE Number(999999999999999999n) =', Number(raw))
  })
  it('precision 8 with a safe-integer sat value is exact', () => {
    for (const v of [2_100_000_000_000_000, 1, 99_999_999, 9_007_199_254_740_991]) {
      console.log(v, '->', formatAmount(v, 8))
    }
  })
})

describe('VERIFY E-F2: convertSdkBalance defaults precision to 8', () => {
  it('a precision-0 RGB asset balance is understated by 1e8', () => {
    const b: any = { settled: 1_000_000, spendable: 1_000_000, future: 0, offchain_outbound: 0, offchain_inbound: 0 }
    const withDefault = convertSdkBalance(b)
    const withReal = convertSdkBalance(b, 0)
    console.log('default(=8):', withDefault.totalDisplay, '| real precision 0:', withReal.totalDisplay)
    expect(withDefault.totalDisplay).toBe('0.01000000')
    expect(withReal.totalDisplay).toBe('1000000')
  })
  it('a precision-2 stablecoin: 10050 units = $100.50', () => {
    const b: any = { settled: 10050, spendable: 10050 }
    console.log('default(=8):', convertSdkBalance(b).totalDisplay, '| real precision 2:', convertSdkBalance(b, 2).totalDisplay)
  })
})

describe('VERIFY E-F3: rgb history converters hardcode precision 8', () => {
  it('a 500-unit precision-0 asset transfer displays as 0.00000500', () => {
    const t = convertTransferToTransaction({ amount: 500, kind: 'receive', status: 'settled', created_at: 1, idx: 1 } as any)
    console.log('transfer amountDisplay:', t.amountDisplay, '| amount:', t.amount)
    expect(t.amountDisplay).toBe('0.00000500')
  })
  it('an asset payment of 500 units displays as 0.00000500', () => {
    const p = convertPaymentToTransaction({ asset_amount: 500, inbound: true, status: 'Succeeded', payment_hash: 'ab', created_at: 1 } as any)
    console.log('payment amountDisplay:', p.amountDisplay, '| amount:', p.amount)
    expect(p.amountDisplay).toBe('0.00000500')
  })
})

describe('VERIFY E-F6: msat->sat rounding disagreement', () => {
  it('decodeBolt11 rounding', () => {
    // 1500 msat = 1.5 sat. Find how each path reports it.
    console.log('rgb-converters payment (Math.floor(msat/1000)):',
      convertPaymentToTransaction({ amt_msat: 1500, inbound: false, status: 'Succeeded', payment_hash: 'x', created_at: 1 } as any).amount)
    console.log('direct RgbAdapter.ts:481 formula (msat/1000):', 1500 / 1000)
    console.log('RlnWdkAdapter.ts:309 formula (Math.floor):', Math.floor(1500 / 1000))
  })
})
