import { describe, expect, it } from 'vitest'
import { sweepWindow } from '../src/lib/spark-deposit-sweep-window'

const addrs = (n: number) => Array.from({ length: n }, (_, i) => `addr-${i}`)

describe('sweepWindow', () => {
  it('scans everything when no limit is given', () => {
    const { addresses, nextOffset } = sweepWindow(addrs(5))
    expect(addresses).toHaveLength(5)
    expect(nextOffset).toBe(0)
  })

  it('scans everything when the limit covers the whole set', () => {
    expect(sweepWindow(addrs(3), { limit: 10 }).addresses).toHaveLength(3)
  })

  it('returns a slice and the cursor to resume from', () => {
    const { addresses, nextOffset } = sweepWindow(addrs(10), { limit: 4 })
    expect(addresses).toEqual(['addr-0', 'addr-1', 'addr-2', 'addr-3'])
    expect(nextOffset).toBe(4)
  })

  it('wraps past the end so a rotating caller covers every address', () => {
    const list = addrs(5)
    const seen: string[] = []
    let offset = 0
    for (let tick = 0; tick < 3; tick++) {
      const window = sweepWindow(list, { limit: 2, offset })
      seen.push(...window.addresses)
      offset = window.nextOffset
    }
    expect(new Set(seen)).toEqual(new Set(list))
    expect(offset).toBe(1)
  })

  it('tolerates a stale cursor from a shrinking address set', () => {
    expect(sweepWindow(addrs(3), { limit: 1, offset: 11 }).addresses).toEqual(['addr-2'])
    expect(sweepWindow(addrs(3), { limit: 1, offset: -1 }).addresses).toEqual(['addr-2'])
  })

  it('handles an empty set and a non-positive limit', () => {
    expect(sweepWindow([], { limit: 5 })).toEqual({ addresses: [], nextOffset: 0 })
    expect(sweepWindow(addrs(3), { limit: 0, offset: 2 })).toEqual({ addresses: [], nextOffset: 2 })
  })
})
