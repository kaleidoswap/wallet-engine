/*
 * Regression test for audit finding E-F1b (REPORT.md §2.2, REPORT-2.md §4.2).
 *
 * `formatAmount(amount, precision)` did `(amount / 10**precision).toFixed(precision)`.
 * `Number#toFixed` accepts 0-100 digits and throws `RangeError` above that. RGB
 * asset precision is a `u8` and Spark token `decimals` is issuer-set, so a
 * crafted asset could carry precision 101-255 — and `formatAmount` sits inside
 * the `listAssets` / `listTransactions` render loop that every adapter feeds.
 * One dust transfer of such an asset therefore threw out of the whole asset list
 * and activity view: denial of service on wallet enumeration, recoverable only
 * with another tool.
 *
 * This file pins two things:
 *  1. the function no longer throws anywhere in its input domain, and
 *  2. it still renders every value it rendered before, byte for byte.
 *
 * (2) matters more than (1). This is the single formatter every adapter's
 * `totalDisplay` / `availableDisplay` / `amountDisplay` goes through, so the
 * REPRODUCTION table below is the measured output of the OLD float
 * implementation, taken at parent 2ddec6f, and every row must still hold.
 */
import { describe, expect, it } from 'vitest'
import { formatAmount, formatSats } from '../../src/lib/amount'

describe('E-F1b: formatAmount must not throw on issuer-supplied precision', () => {
  it('renders precision above toFixed\'s 100-digit ceiling instead of throwing', () => {
    // The exact call that used to throw `RangeError: toFixed() digits argument
    // must be between 0 and 100`.
    expect(formatAmount(5, 200)).toBe('0.' + '0'.repeat(199) + '5')
    expect(formatAmount(1, 101)).toBe('0.' + '0'.repeat(100) + '1')
    // RGB precision is a u8, so 255 is a legal value an issuer may publish.
    expect(formatAmount(1, 255)).toBe('0.' + '0'.repeat(254) + '1')
    expect(() => formatAmount(1, 255)).not.toThrow()
  })

  it('nothing in the input domain throws', () => {
    const amounts = [0, 1, -1, 1.5, -1.5, 1e21, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity]
    const precisions = [-1, 0, 1, 8, 18, 100, 101, 255, NaN, Infinity]
    for (const a of amounts) {
      for (const p of precisions) {
        expect(() => formatAmount(a, p), `formatAmount(${a}, ${p})`).not.toThrow()
        expect(typeof formatAmount(a, p)).toBe('string')
      }
    }
  })

  it('renders the number it was actually given, where float division rounded', () => {
    // `1e24` is not 10^24 as a double — it is 999999999999999983222784, and the
    // digits were lost at the CALL SITE, before formatAmount saw anything.
    // Digit-shifting the BigInt shows that value; `amount / 1e8` then
    // `.toFixed(8)` rounded it back to a clean "10000000000000000.00000000",
    // reporting a balance the wallet does not have.
    expect(1e24).toBe(999999999999999983222784)
    expect(formatAmount(1e24, 8)).toBe('9999999999999999.83222784')
    expect(formatAmount(Number.MAX_SAFE_INTEGER, 8)).toBe('90071992.54740991')
  })

  /*
   * REPRODUCTION — the OLD float implementation's measured output, captured at
   * parent 2ddec6f by calling it on each pair. Every row must still hold: this
   * is the safety net for a function every adapter depends on.
   */
  const PRESERVED: ReadonlyArray<[number, number, string]> = [
    [0, 0, '0'],
    [0, 8, '0.00000000'],
    [1, 0, '1'],
    [1, -1, '1'],
    [42, 0, '42'],
    [42, -1, '42'],
    [1, 2, '0.01'],
    [150, 2, '1.50'],
    [1, 8, '0.00000001'],
    [-1, 8, '-0.00000001'],
    [1_000_000, 8, '0.01000000'],
    [100_000_000, 8, '1.00000000'],
    [2_100_000_000_000_000, 8, '21000000.00000000'],
    [9_007_199_254_740_991, 8, '90071992.54740991'],
    [1e21, 8, '10000000000000.00000000'],
    [1.5, 8, '0.00000001'],
    [0.1, 20, '0.00000000000000000000'],
    [123, 20, '0.00000000000000000123'],
    // Number(10n**18n - 1n) is 1e18 exactly — the digit was already lost at the
    // call site, before formatAmount ever saw it. Both implementations agree.
    [Number(10n ** 18n - 1n), 18, '1.000000000000000000'],
    [NaN, 8, 'NaN'],
    [Infinity, 8, 'Infinity'],
  ]

  for (const [amount, precision, expected] of PRESERVED) {
    it(`preserves formatAmount(${amount}, ${precision}) === ${JSON.stringify(expected)}`, () => {
      expect(formatAmount(amount, precision)).toBe(expected)
    })
  }

  it('formatSats is unchanged', () => {
    expect(formatSats(100_000_000)).toBe('1.00000000')
    expect(formatSats(0)).toBe('0.00000000')
  })
})
