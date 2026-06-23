/**
 * Destination Classifier
 * ----------------------
 * Pure, dependency-free classification of a send destination string into a
 * (kind, layer, candidate protocols) triple. The cross-protocol router uses this
 * to decide which adapter(s) can pay a given destination — without any adapter
 * needing to know about the others.
 *
 * This is the cross-protocol layer that WDK's per-module detection does NOT cover:
 * WDK detects within a protocol; this chooses BETWEEN protocols.
 */

import { ProtocolType, Layer, AddressFormat } from '../types/base'

export type DestinationKind =
  | 'BOLT11' // Lightning invoice
  | 'LN_ADDRESS' // lightning address / LNURL
  | 'RGB_INVOICE' // RGB invoice
  | 'SPARK' // Spark address/invoice
  | 'ARKADE' // Ark address
  | 'LIQUID' // Liquid (confidential) address
  | 'BTC_ONCHAIN' // bare Bitcoin L1 address
  | 'BIP21' // bitcoin: URI (may embed a lightning= fallback)
  | 'UNKNOWN'

export interface ClassifiedDestination {
  kind: DestinationKind
  /** The most specific layer this destination settles on. */
  layer: Layer | null
  /** Address format (for passing to swap receiverAddressFormat / UI). */
  format: AddressFormat | null
  /** Protocols capable of paying this destination, best-first. */
  candidates: ProtocolType[]
  /** For BIP21: an embedded BOLT11 fallback, if present. */
  lightningFallback?: string
  /** The normalized payable string (URI-stripped where relevant). */
  value: string
}

// Matchers are deliberately STRICT and anchored: the classifier directs funds,
// so it must fail CLOSED (→ UNKNOWN, no candidates) on anything it cannot
// positively identify. A loose prefix that matches arbitrary text (the old
// Liquid `H`/`VT`/`Az` and the bare-letter BTC fallbacks) is a fund-misrouting
// bug, not a convenience.
const RE = {
  bolt11: /^ln(bc|tb|bcrt|sb)[0-9]/i,
  lnurl: /^lnurl[0-9a-z]+$/i,
  lnAddress: /^[^@\s]+@[^@\s]+\.[^@\s]+$/i,
  rgb: /^(rgb:|utxob:)/i,
  spark: /^(spark|sparkrt|sprt|spt)1[0-9a-z]{6,}$/i,
  arkade: /^(ark|tark)1[0-9a-z]{6,}$/i,
  // Liquid bech32/blech32 only (confidential `lq1`, unconfidential `ex1`, +
  // testnet/regtest variants). Legacy base58 Liquid prefixes are intentionally
  // dropped: `VT`/`H`/`Gq` are indistinguishable from arbitrary text.
  liquid: /^(lq1|tlq1|ex1|tex1|el1|ert1)[0-9a-z]{6,}$/i,
  // BTC bech32 (charset excludes 1/b/i/o) or legacy base58 (charset excludes
  // 0/O/I/l), length-bounded so junk like `not-an-address` cannot match.
  btc: /^(bc1|tb1|bcrt1)[02-9ac-hj-np-z]{6,87}$|^[13mn2][a-km-zA-HJ-NP-Z1-9]{25,39}$/,
  bip21: /^bitcoin:/i,
}

/** Pull a `lightning=` parameter out of a BIP21 URI, if present. */
function extractLightning(uri: string): string | undefined {
  const m = uri.match(/[?&]lightning=([^&]+)/i)
  return m ? decodeURIComponent(m[1]) : undefined
}

export function classifyDestination(raw: string): ClassifiedDestination {
  const dest = (raw ?? '').trim()

  if (RE.bip21.test(dest)) {
    const addr = dest.slice('bitcoin:'.length).split('?')[0]
    const lightningFallback = extractLightning(dest)
    return {
      kind: 'BIP21',
      layer: 'BTC_L1',
      format: 'BTC_ADDRESS',
      // On-chain BTC can be served by any protocol with a Bitcoin on-chain path.
      // LIQUID is excluded: it's a separate L1 and cannot settle a BTC address.
      // (An embedded `lightning=` fallback widens the route at the router layer.)
      candidates: ['RGB', 'ARKADE', 'SPARK'],
      lightningFallback,
      value: addr,
    }
  }

  if (RE.bolt11.test(dest)) {
    return { kind: 'BOLT11', layer: 'BTC_LN', format: 'BOLT11', candidates: ['RGB', 'SPARK', 'ARKADE'], value: dest }
  }

  if (RE.lnurl.test(dest) || RE.lnAddress.test(dest)) {
    return { kind: 'LN_ADDRESS', layer: 'BTC_LN', format: 'BOLT11', candidates: ['RGB', 'SPARK', 'ARKADE'], value: dest }
  }

  if (RE.rgb.test(dest)) {
    return { kind: 'RGB_INVOICE', layer: 'RGB_LN', format: 'RGB_INVOICE', candidates: ['RGB'], value: dest }
  }

  if (RE.spark.test(dest)) {
    return { kind: 'SPARK', layer: 'SPARK_SPARK', format: 'SPARK_ADDRESS', candidates: ['SPARK'], value: dest }
  }

  if (RE.arkade.test(dest)) {
    return { kind: 'ARKADE', layer: 'ARKADE_ARKADE', format: 'ARKADE_ADDRESS', candidates: ['ARKADE'], value: dest }
  }

  if (RE.liquid.test(dest)) {
    return { kind: 'LIQUID', layer: 'BTC_LIQUID', format: 'LIQUID_ADDRESS', candidates: ['LIQUID'], value: dest }
  }

  if (RE.btc.test(dest)) {
    return {
      kind: 'BTC_ONCHAIN',
      layer: 'BTC_L1',
      format: 'BTC_ADDRESS',
      candidates: ['RGB', 'ARKADE', 'SPARK'], // protocols that can pay an on-chain BTC address
      value: dest,
    }
  }

  return { kind: 'UNKNOWN', layer: null, format: null, candidates: [], value: dest }
}
