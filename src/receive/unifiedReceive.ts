/** Build and parse BIP321 receive URIs with optional Kaleido-specific rails. */

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

/** Build one BIP321 URI; the address is optional but some receive rail is required. */
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
  // Only emit `amount` for a finite, strictly-positive value: a 0, negative or
  // non-finite input (or dust rounding to "0" at 8 decimals) would otherwise put a
  // meaningless `amount=0` in the QR that a payer's wallet reads literally.
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
  // Encode the path so reserved characters cannot inject payment rails.
  return `bitcoin:${encodeURIComponent(p.btcAddress ?? '')}${qs ? `?${qs}` : ''}`
}

/** Parse a BIP321 unified URI back into its parts (Kaleido wallets use this on scan). */
export function parseUnifiedReceiveURI(uri: string): UnifiedReceiveParams | null {
  // Address is optional under BIP321 → allow an empty path.
  const m = (uri ?? '').trim().match(/^bitcoin:([^?]*)(?:\?(.*))?$/i)
  if (!m) return null
  const btcAddress = decodePath(m[1]) || undefined
  const params = new URLSearchParams(m[2] ?? '')
  return {
    btcAddress,
    // Invalid BTC amounts stay undefined rather than flowing into a send.
    amountBtc: toDecimalAmount(params.get('amount'), { maxDecimals: 8, max: MAX_BTC }),
    label: params.get('label') ?? undefined,
    lightningInvoice: params.get(K.lightning) ?? undefined,
    lightningOffer: params.get(K.lno) ?? undefined,
    sparkAddress: params.get(K.spark) ?? undefined,
    arkadeAddress: params.get(K.ark) ?? undefined,
    liquidAddress: params.get(K.liquid) ?? undefined,
    rgbInvoice: params.get(K.rgb) ?? undefined,
    assetId: params.get(K.assetId) ?? undefined,
    // Asset amounts are in the asset's own display units, so no 8-decimal cap.
    assetAmount: toDecimalAmount(params.get(K.assetAmount)),
  }
}

/** Match the BIP21 decimal grammar instead of `Number()`'s hex/exponent forms. */
const DECIMAL_AMOUNT = /^\d+(?:\.\d+)?$/

function toDecimalAmount(v: string | null, opts: { maxDecimals?: number; max?: number } = {}): number | undefined {
  if (v == null || !DECIMAL_AMOUNT.test(v)) return undefined
  const [, frac = ''] = v.split('.')
  if (opts.maxDecimals != null && frac.length > opts.maxDecimals) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return undefined
  if (opts.max != null && n > opts.max) return undefined
  return n
}

/** Malformed path encoding falls back to raw text instead of aborting a scan. */
function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Largest amount BIP21 can meaningfully carry: the whole BTC supply. */
const MAX_BTC = 21_000_000

/** BIP21/BIP321 amounts are in BTC with up to 8 decimals, no trailing zeros / exponent. */
function formatBtc(amountBtc: number): string {
  return amountBtc.toFixed(8).replace(/\.?0+$/, '')
}

/**
 * List independent, unbound payment rails so callers can authorize the selected
 * one instead of silently auto-paying another.
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
