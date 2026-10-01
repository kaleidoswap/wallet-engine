/**
 * Windowing for the Spark single-use deposit sweep.
 *
 * Sweeping costs one UTXO lookup per unused deposit address, and that set only
 * grows — Spark issues a fresh address on every receive. A caller on a timer can
 * pass a `limit` to pay for a slice per tick instead of the whole set, feeding
 * the previous result's `nextOffset` back in. The window wraps past the end of
 * the list so a rotating caller still covers every address, just spread over
 * several sweeps.
 */
export function sweepWindow(
  addresses: string[],
  options?: { limit?: number; offset?: number },
): { addresses: string[]; nextOffset: number } {
  const total = addresses.length
  if (total === 0) return { addresses: [], nextOffset: 0 }

  const limit = options?.limit
  // No limit (or one that covers everything) means the historical behaviour:
  // scan the whole set, and leave the caller's cursor at the start.
  if (limit === undefined || !Number.isFinite(limit) || limit >= total) {
    return { addresses: [...addresses], nextOffset: 0 }
  }
  if (limit <= 0) return { addresses: [], nextOffset: normalizeOffset(options?.offset, total) }

  const size = Math.floor(limit)
  const offset = normalizeOffset(options?.offset, total)
  const window: string[] = []
  for (let i = 0; i < size; i++) window.push(addresses[(offset + i) % total])
  return { addresses: window, nextOffset: (offset + size) % total }
}

function normalizeOffset(offset: number | undefined, total: number): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0
  const floored = Math.floor(offset)
  // Negative or past-the-end cursors (a shrinking address set) wrap rather than
  // throwing — the caller's stored cursor is allowed to go stale.
  return ((floored % total) + total) % total
}
