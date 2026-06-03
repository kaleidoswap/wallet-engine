/**
 * Minimal, dependency-free BOLT11 helper.
 * ---------------------------------------
 * Extracts the amount + network from a Lightning invoice's human-readable prefix
 * (HRP) without a full bech32 decode. Enough for adapters that only need to show
 * "how much" before paying (Spark, Arkade), and to avoid pulling a decoder dep.
 * Full field decode (payment_hash, description) is left to node-side decoders (RLN).
 */

const MULTIPLIER: Record<string, number> = { m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 }

export interface Bolt11Summary {
  /** Amount in satoshis, if the invoice encodes one (open invoices omit it). */
  amountSat?: number
  /** Network token from the HRP: bc | tb | tbs | bcrt. */
  network: string
}

/** Parse a BOLT11 invoice's HRP for amount + network. Returns network 'unknown' if not BOLT11. */
export function decodeBolt11(invoice: string): Bolt11Summary {
  const s = (invoice ?? '').trim().toLowerCase()
  // HRP = ln <currency> [<amount><multiplier>] then the bech32 '1' separator.
  // Requiring the trailing '1' makes the optional amount backtrack correctly, so the
  // separator itself is never mistaken for an amount (e.g. amountless `lnbc1...`).
  const m = s.match(/^ln(bcrt|tbs|bc|tb)(?:(\d+)([munp]?))?1/)
  if (!m) return { network: 'unknown' }
  const network = m[1]
  const digits = m[2]
  const mult = m[3]
  if (!digits) return { network } // amountless / open invoice
  const base = Number(digits)
  const btc = mult ? base * MULTIPLIER[mult] : base
  return { amountSat: Math.round(btc * 1e8), network }
}

export function isBolt11(s: string): boolean {
  return /^ln(bcrt|tbs|bc|tb)[0-9]/i.test((s ?? '').trim())
}
