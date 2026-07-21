import { describe, it, expect } from 'vitest'
import { formatAmount, formatSats } from '../src/lib/amount'

describe('formatAmount', () => {
  it('renders a raw integer at the given precision', () => {
    expect(formatAmount(100_000_000, 8)).toBe('1.00000000')
    expect(formatAmount(1_000_000, 8)).toBe('0.01000000')
    expect(formatAmount(1, 8)).toBe('0.00000001')
  })

  it('emits exactly `precision` fractional digits', () => {
    expect(formatAmount(150, 2)).toBe('1.50')
    expect(formatAmount(1, 2)).toBe('0.01')
  })

  it('renders integers as-is for non-positive precision', () => {
    expect(formatAmount(42, 0)).toBe('42')
    expect(formatAmount(42, -1)).toBe('42')
  })

  it('formatSats is BTC display at precision 8', () => {
    expect(formatSats(100_000_000)).toBe('1.00000000')
    expect(formatSats(0)).toBe('0.00000000')
  })
})
