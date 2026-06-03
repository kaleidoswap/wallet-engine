/**
 * Unified Receive URI
 * -------------------
 * Builds ONE QR payload that any wallet can pay, while Kaleido-aware wallets get
 * the richer multi-protocol options. The base is a standards-compliant BIP21
 * `bitcoin:` URI (on-chain address + optional `lightning=` BOLT11) — understood by
 * every wallet. Ark / Spark / Liquid / RGB are carried as extra params that only
 * Kaleido wallets read; other wallets ignore them and fall back to on-chain/LN.
 *
 * This is the "single QR with embedded LN, Ark, Spark addresses" the lite-mode
 * receive flow needs. Pure + dependency-free.
 */

export interface UnifiedReceiveParams {
  /** On-chain BTC address — the universal fallback any wallet understands. Required. */
  btcAddress: string
  /** BOLT11 invoice for Lightning (standard BIP21 `lightning=`). */
  lightningInvoice?: string
  /** Spark address/invoice (Kaleido-only param). */
  sparkAddress?: string
  /** Arkade address (Kaleido-only param). */
  arkadeAddress?: string
  /** Liquid address (Kaleido-only param). */
  liquidAddress?: string
  /** RGB invoice (Kaleido-only param). */
  rgbInvoice?: string
  /** Amount in BTC (BIP21 `amount`). */
  amountBtc?: number
  /** Human label/message. */
  label?: string
  /** RGB/Liquid asset id, when receiving a specific asset. */
  assetId?: string
  /** Asset amount in display units. */
  assetAmount?: number
}

/** Kaleido-namespaced BIP21 params (lowercase; other wallets ignore unknown params). */
const K = {
  spark: 'spark',
  ark: 'ark',
  liquid: 'liquid',
  rgb: 'rgb',
  assetId: 'assetid',
  assetAmount: 'assetamount',
} as const

/**
 * Build a single BIP21 URI carrying every available receive method.
 * Example: bitcoin:bc1q...?amount=0.001&lightning=lnbc...&spark=spark1...&ark=ark1...
 */
export function buildUnifiedReceiveURI(p: UnifiedReceiveParams): string {
  if (!p.btcAddress) throw new Error('buildUnifiedReceiveURI requires a btcAddress (universal fallback)')
  const params = new URLSearchParams()
  if (p.amountBtc != null) params.set('amount', formatBtc(p.amountBtc))
  if (p.label) params.set('label', p.label)
  if (p.lightningInvoice) params.set('lightning', p.lightningInvoice)
  if (p.sparkAddress) params.set(K.spark, p.sparkAddress)
  if (p.arkadeAddress) params.set(K.ark, p.arkadeAddress)
  if (p.liquidAddress) params.set(K.liquid, p.liquidAddress)
  if (p.rgbInvoice) params.set(K.rgb, p.rgbInvoice)
  if (p.assetId) params.set(K.assetId, p.assetId)
  if (p.assetAmount != null) params.set(K.assetAmount, String(p.assetAmount))
  const qs = params.toString()
  return `bitcoin:${p.btcAddress}${qs ? `?${qs}` : ''}`
}

/** Parse a unified URI back into its parts (Kaleido wallets use this on scan). */
export function parseUnifiedReceiveURI(uri: string): UnifiedReceiveParams | null {
  const m = (uri ?? '').trim().match(/^bitcoin:([^?]+)(?:\?(.*))?$/i)
  if (!m) return null
  const btcAddress = m[1]
  const params = new URLSearchParams(m[2] ?? '')
  const amount = params.get('amount')
  const assetAmount = params.get(K.assetAmount)
  return {
    btcAddress,
    amountBtc: amount != null ? Number(amount) : undefined,
    label: params.get('label') ?? undefined,
    lightningInvoice: params.get('lightning') ?? undefined,
    sparkAddress: params.get(K.spark) ?? undefined,
    arkadeAddress: params.get(K.ark) ?? undefined,
    liquidAddress: params.get(K.liquid) ?? undefined,
    rgbInvoice: params.get(K.rgb) ?? undefined,
    assetId: params.get(K.assetId) ?? undefined,
    assetAmount: assetAmount != null ? Number(assetAmount) : undefined,
  }
}

/** BIP21 amounts are in BTC with up to 8 decimals, no trailing zeros / exponent. */
function formatBtc(amountBtc: number): string {
  return amountBtc.toFixed(8).replace(/\.?0+$/, '')
}
