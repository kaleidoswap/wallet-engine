/**
 * Destination Classifier
 * ----------------------
 * Pure, dependency-free classification of a send destination into a (kind, layer,
 * candidate protocols) triple, so the router can pick an adapter without any
 * adapter knowing about the others. WDK detects within a protocol; this chooses
 * BETWEEN protocols.
 */

import { base58check } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'

import { ProtocolType, Layer, AddressFormat } from '../types/base'

// Checksum-verified base58 decoder (double-SHA256), reused across calls. Uses
// the same vetted primitives the rest of the engine already depends on.
const base58checkDecode = base58check(sha256).decode

// Liquid "blinded" (confidential) base58 version bytes, per rust-elements
// AddressParams: 12 = Liquid mainnet, 23 = Liquid testnet, 4 = Elements regtest.
const LIQUID_CONFIDENTIAL_VERSIONS = new Set([12, 23, 4])

/**
 * True for a legacy base58 *confidential* Liquid address (`VJL…`/`VT…` and the
 * testnet/regtest equivalents). Unlike the unconfidential base58 forms — which are
 * indistinguishable from arbitrary text or BTC and so are deliberately NOT matched
 * — a confidential address decodes to a fixed 55-byte payload whose first byte is
 * the network's blinded prefix. That plus the base58check checksum makes it
 * unambiguous, and it still fails CLOSED on junk, BTC, or a bad checksum.
 */
function isLiquidConfidentialBase58(dest: string): boolean {
  try {
    const payload = base58checkDecode(dest)
    return payload.length === 55 && LIQUID_CONFIDENTIAL_VERSIONS.has(payload[0])
  } catch {
    return false
  }
}

export type DestinationKind =
  | 'BOLT11' // Lightning invoice
  | 'BOLT12' // Lightning offer (BIP321 `lno=`)
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

// Matchers are deliberately STRICT and anchored: the classifier directs funds, so
// it must fail CLOSED (→ UNKNOWN) on anything it cannot positively identify. A
// loose prefix matching arbitrary text is a fund-misrouting bug, not a convenience.
const RE = {
  // BOLT11 prefixes: bc (mainnet), tb (testnet), tbs (signet/Mutinynet), bcrt.
  // `tbs` MUST precede `tb`, else `tb` matches first and the required trailing
  // `[0-9]` sees the `s` and fails, misrouting a signet invoice to UNKNOWN.
  // Kept in sync with `lib/bolt11.ts`.
  bolt11: /^ln(bcrt|tbs|bc|tb)[0-9]/i,
  bolt12: /^lno1[0-9a-z]+$/i,
  lnurl: /^lnurl[0-9a-z]+$/i,
  lnAddress: /^[^@\s]+@[^@\s]+\.[^@\s]+$/i,
  rgb: /^(rgb:|utxob:)/i,
  // Spark bech32m HRPs per the SDK's address encoder: `spark1`, `sparkt1`,
  // `sparkrt1`, `sparkl1`, plus legacy `spl1`/`sprt1`. `sp1` is deliberately NOT
  // here — it belongs to BIP352 Silent Payments, so matching it as Spark would
  // misroute funds. Longest prefixes first.
  spark: /^(sparkrt|sparkt|sparkl|spark|sprt|spl)1[0-9a-z]{6,}$/i,
  arkade: /^(ark|tark)1[0-9a-z]{6,}$/i,
  // Liquid bech32/blech32 (`lq1` confidential, `ex1` unconfidential, + testnet/
  // regtest). Legacy confidential base58 goes through
  // isLiquidConfidentialBase58; the unconfidential base58 forms stay dropped as
  // indistinguishable from arbitrary text / BTC.
  liquid: /^(lq1|tlq1|ex1|tex1|el1|ert1)[0-9a-z]{6,}$/i,
  // BTC bech32 (charset excludes 1/b/i/o) or legacy base58 (charset excludes
  // 0/O/I/l), length-bounded so junk like `not-an-address` cannot match.
  btc: /^(bc1|tb1|bcrt1)[02-9ac-hj-np-z]{6,87}$|^[13mn2][a-km-zA-HJ-NP-Z1-9]{25,39}$/,
  bip21: /^bitcoin:/i,
}

/** Pull a `lightning=` parameter out of a BIP21 URI, if present. */
function extractLightning(uri: string): string | undefined {
  const m = uri.match(/[?&]lightning=([^&]+)/i)
  if (!m) return undefined
  // Malformed percent-encoding (hostile QR) must not throw out of the
  // classifier — treat it as no usable lightning parameter.
  try {
    return decodeURIComponent(m[1])
  } catch {
    return undefined
  }
}

export function classifyDestination(raw: string): ClassifiedDestination {
  const dest = (raw ?? '').trim()

  if (RE.bip21.test(dest)) {
    const addr = dest.slice('bitcoin:'.length).split('?')[0]
    const lightningFallback = extractLightning(dest)
    // BIP321 allows an address-less URI (`bitcoin:?lightning=…`). With no on-chain
    // address, fail CLOSED rather than emit a `direct` route whose `value` is the
    // empty string — that would let lite mode auto-select a send to an empty
    // destination while dropping the embedded rails. Callers wanting those must go
    // through `resolveUnifiedSend`; `lightningFallback` is still surfaced.
    if (!addr) {
      return { kind: 'BIP21', layer: null, format: null, candidates: [], lightningFallback, value: '' }
    }
    // The `bitcoin:` prefix must not buy an address a validation exemption. Every
    // other branch below is an anchored matcher and anything unmatched falls
    // through to UNKNOWN; without the same check here, `bitcoin:<anything>` yields
    // a BTC_L1 route with `direct: true` for arbitrary text — and routes a Liquid
    // address as an on-chain Bitcoin send. Fail CLOSED on an address we cannot
    // positively identify as Bitcoin, exactly as the address-less form above does,
    // while still surfacing `lightningFallback` so a caller can route that rail
    // explicitly. (`resolveUnifiedSend` already re-classifies each rail and so was
    // never affected; this makes the two entry points agree.)
    if (!RE.btc.test(addr)) {
      return { kind: 'BIP21', layer: null, format: null, candidates: [], lightningFallback, value: addr }
    }
    return {
      kind: 'BIP21',
      layer: 'BTC_L1',
      format: 'BTC_ADDRESS',
      // On-chain BTC can be served by any protocol with a Bitcoin on-chain path.
      // LIQUID is excluded: it's a separate L1 and cannot settle a BTC address.
      // (An embedded `lightning=` fallback widens the route at the router layer.)
      candidates: ['RGB_LN', 'RGB_L1', 'ARKADE', 'SPARK'],
      lightningFallback,
      value: addr,
    }
  }

  if (RE.bolt12.test(dest)) {
    return { kind: 'BOLT12', layer: 'BTC_LN', format: 'BOLT12', candidates: ['RGB_LN', 'SPARK', 'ARKADE'], value: dest }
  }

  if (RE.bolt11.test(dest)) {
    return { kind: 'BOLT11', layer: 'BTC_LN', format: 'BOLT11', candidates: ['RGB_LN', 'SPARK', 'ARKADE'], value: dest }
  }

  if (RE.lnurl.test(dest) || RE.lnAddress.test(dest)) {
    return { kind: 'LN_ADDRESS', layer: 'BTC_LN', format: 'BOLT11', candidates: ['RGB_LN', 'SPARK', 'ARKADE'], value: dest }
  }

  if (RE.rgb.test(dest)) {
    // Either RGB backing can pay an RGB invoice; the router filters to whichever
    // is registered + connected (and verifies it can settle the layer).
    return { kind: 'RGB_INVOICE', layer: 'RGB_LN', format: 'RGB_INVOICE', candidates: ['RGB_LN', 'RGB_L1'], value: dest }
  }

  if (RE.spark.test(dest)) {
    return { kind: 'SPARK', layer: 'SPARK_SPARK', format: 'SPARK_ADDRESS', candidates: ['SPARK'], value: dest }
  }

  if (RE.arkade.test(dest)) {
    return { kind: 'ARKADE', layer: 'ARKADE_ARKADE', format: 'ARKADE_ADDRESS', candidates: ['ARKADE'], value: dest }
  }

  if (RE.liquid.test(dest) || isLiquidConfidentialBase58(dest)) {
    return { kind: 'LIQUID', layer: 'BTC_LIQUID', format: 'LIQUID_ADDRESS', candidates: ['LIQUID'], value: dest }
  }

  if (RE.btc.test(dest)) {
    return {
      kind: 'BTC_ONCHAIN',
      layer: 'BTC_L1',
      format: 'BTC_ADDRESS',
      candidates: ['RGB_LN', 'RGB_L1', 'ARKADE', 'SPARK'], // protocols that can pay an on-chain BTC address
      value: dest,
    }
  }

  return { kind: 'UNKNOWN', layer: null, format: null, candidates: [], value: dest }
}
