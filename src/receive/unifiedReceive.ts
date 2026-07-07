/**
 * Unified Receive URI (BIP321)
 * ----------------------------
 * Builds ONE QR payload that any wallet can pay, while Kaleido-aware wallets get the
 * richer multi-protocol options. The base is a **BIP321** `bitcoin:` URI — the
 * generalized successor to BIP21: an optional on-chain address in the path plus
 * payment methods as query params (`lightning=` BOLT11, `lno=` BOLT12), and unknown
 * params are ignored by other wallets. It stays backward-compatible with BIP21
 * (the `bitcoin:` scheme + `amount`/`label`/`lightning` are understood by BIP21 wallets).
 *
 * Per BIP321 the address MAY be omitted (`bitcoin:?lightning=...&spark=...`), so a
 * lite wallet with no on-chain address can still publish one QR. Ark / Spark / Liquid
 * / RGB ride as extra (non-standard) params that only Kaleido wallets read.
 *
 * This is the "single QR with embedded LN, Ark, Spark addresses" the lite-mode
 * receive flow needs. Pure + dependency-free.
 */

export interface UnifiedReceiveParams {
  /** On-chain BTC address. OPTIONAL under BIP321 — omit for a LN/asset-only QR. */
  btcAddress?: string
  /** BOLT11 invoice for Lightning (BIP321 `lightning=`). */
  lightningInvoice?: string
  /** BOLT12 offer for Lightning (BIP321 `lno=`). */
  lightningOffer?: string
  /** Spark address/invoice (Kaleido-only param). */
  sparkAddress?: string
  /** Arkade address (Kaleido-only param). */
  arkadeAddress?: string
  /** Liquid address (Kaleido-only param). */
  liquidAddress?: string
  /** RGB invoice (Kaleido-only param). */
  rgbInvoice?: string
  /** Amount in BTC (BIP21/BIP321 `amount`). */
  amountBtc?: number
  /** Human label/message. */
  label?: string
  /** RGB/Liquid asset id, when receiving a specific asset. */
  assetId?: string
  /** Asset amount in display units. */
  assetAmount?: number
}

/** BIP321 query keys (case-insensitive). `lightning`/`lno` are standard; the rest are Kaleido-namespaced. */
const K = {
  lightning: 'lightning',
  lno: 'lno',
  spark: 'spark',
  ark: 'ark',
  liquid: 'liquid',
  rgb: 'rgb',
  assetId: 'assetid',
  assetAmount: 'assetamount',
} as const

/**
 * Build a single BIP321 `bitcoin:` URI carrying every available receive method.
 * The address is optional; at least one of (address | lightning | lno | spark | ark |
 * liquid | rgb) must be present.
 *
 * Examples:
 *   bitcoin:bc1q...?amount=0.001&lightning=lnbc...&spark=spark1...&ark=ark1...
 *   bitcoin:?lightning=lnbc...&liquid=lq1...           (BIP321: address omitted)
 */
export function buildUnifiedReceiveURI(p: UnifiedReceiveParams): string {
  const hasMethod =
    !!p.btcAddress ||
    !!p.lightningInvoice ||
    !!p.lightningOffer ||
    !!p.sparkAddress ||
    !!p.arkadeAddress ||
    !!p.liquidAddress ||
    !!p.rgbInvoice
  if (!hasMethod) {
    throw new Error('buildUnifiedReceiveURI requires at least one receive method (address or a payment param)')
  }

  const params = new URLSearchParams()
  // Only emit `amount` for a finite, strictly-positive value. A 0, negative, or
  // non-finite input (or a dust amount that rounds to "0" at 8 decimals) would
  // otherwise produce a meaningless `amount=0` / `amount=-0.001` in the QR that
  // a payer's wallet reads literally. Mirrors the parse-side non-negative guard.
  if (p.amountBtc != null && Number.isFinite(p.amountBtc) && p.amountBtc > 0) {
    const amount = formatBtc(p.amountBtc)
    if (amount !== '0') params.set('amount', amount)
  }
  if (p.label) params.set('label', p.label)
  if (p.lightningInvoice) params.set(K.lightning, p.lightningInvoice)
  if (p.lightningOffer) params.set(K.lno, p.lightningOffer)
  if (p.sparkAddress) params.set(K.spark, p.sparkAddress)
  if (p.arkadeAddress) params.set(K.ark, p.arkadeAddress)
  if (p.liquidAddress) params.set(K.liquid, p.liquidAddress)
  if (p.rgbInvoice) params.set(K.rgb, p.rgbInvoice)
  if (p.assetId) params.set(K.assetId, p.assetId)
  // Same non-negative/finite guard as `amount`: never emit a junk asset amount.
  if (p.assetAmount != null && Number.isFinite(p.assetAmount) && p.assetAmount > 0) {
    params.set(K.assetAmount, String(p.assetAmount))
  }

  const qs = params.toString()
  // BIP321: `bitcoin:` + optional address + optional `?params`.
  return `bitcoin:${p.btcAddress ?? ''}${qs ? `?${qs}` : ''}`
}

/** Parse a BIP321 unified URI back into its parts (Kaleido wallets use this on scan). */
export function parseUnifiedReceiveURI(uri: string): UnifiedReceiveParams | null {
  // Address is optional under BIP321 → allow an empty path.
  const m = (uri ?? '').trim().match(/^bitcoin:([^?]*)(?:\?(.*))?$/i)
  if (!m) return null
  const btcAddress = m[1] || undefined
  const params = new URLSearchParams(m[2] ?? '')
  return {
    btcAddress,
    // Amounts are coerced through a finite/non-negative guard: a junk, negative,
    // or non-finite `amount=` must surface as `undefined`, never as NaN/-1/Infinity
    // flowing into a send.
    amountBtc: toNonNegativeFinite(params.get('amount')),
    label: params.get('label') ?? undefined,
    lightningInvoice: params.get(K.lightning) ?? undefined,
    lightningOffer: params.get(K.lno) ?? undefined,
    sparkAddress: params.get(K.spark) ?? undefined,
    arkadeAddress: params.get(K.ark) ?? undefined,
    liquidAddress: params.get(K.liquid) ?? undefined,
    rgbInvoice: params.get(K.rgb) ?? undefined,
    assetId: params.get(K.assetId) ?? undefined,
    assetAmount: toNonNegativeFinite(params.get(K.assetAmount)),
  }
}

/** Parse a query value as a finite, non-negative number, else `undefined`. */
function toNonNegativeFinite(v: string | null): number | undefined {
  if (v == null || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** BIP21/BIP321 amounts are in BTC with up to 8 decimals, no trailing zeros / exponent. */
function formatBtc(amountBtc: number): string {
  return amountBtc.toFixed(8).replace(/\.?0+$/, '')
}

/**
 * The distinct payment methods present in a parsed unified URI.
 *
 * A unified `bitcoin:` URI may carry several independent payment methods (an
 * on-chain address AND a `lightning=` invoice AND an asset invoice). They are
 * NOT cryptographically bound to one another — a scanned QR could pair an
 * address with an unrelated invoice. Consumers MUST present the methods and let
 * the user/router choose one explicitly; they must not silently auto-pay a
 * different method than the one the user intended. This helper enumerates what's
 * on offer so the UI can do that.
 */
export function receiveMethodsOf(p: UnifiedReceiveParams): Array<keyof UnifiedReceiveParams> {
  const keys: Array<keyof UnifiedReceiveParams> = [
    'btcAddress',
    'lightningInvoice',
    'lightningOffer',
    'sparkAddress',
    'arkadeAddress',
    'liquidAddress',
    'rgbInvoice',
  ]
  return keys.filter((k) => p[k] != null && p[k] !== '')
}
