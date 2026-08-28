/**
 * CrossProtocolRouter
 * -------------------
 * Sits ON TOP of the adapters and chooses BETWEEN protocols: given a destination
 * or receive intent, returns the protocol(s) that can fulfil it, filtered to what
 * is registered and connected. This is what makes lite mode possible.
 *
 * Reads the capability manifest and the destination classifier — never adapter
 * internals.
 */

import { ProtocolAdapterRegistry, IProtocolAdapter } from '../adapters/IProtocolAdapter'
import { ProtocolType, Layer } from '../types/base'
import { getCapabilities } from '../capabilities'
import { classifyDestination, ClassifiedDestination } from './destination'
import { parseUnifiedReceiveURI, type UnifiedReceiveParams } from '../receive/unifiedReceive'
import {
  type Rail,
  type RoutePreference,
  layerPreferenceFor,
  compareByPreference,
  railOfKind,
} from './preference'

/**
 * Whether `protocol` can pay `dest` DIRECTLY (no swap), per the capability
 * manifest. Reads capability flags rather than exact layer strings, so a protocol
 * reaching a surface by another path (Spark paying on-chain via a deposit/exit) is
 * still recognised.
 */
function canSettleDirectly(protocol: ProtocolType, dest: ClassifiedDestination): boolean {
  const caps = getCapabilities(protocol)
  switch (dest.kind) {
    case 'BOLT11':
    case 'BOLT12':
    case 'LN_ADDRESS':
      return caps.supportsLightning
    case 'BTC_ONCHAIN':
    case 'BIP21':
      return caps.supportsOnchain
    case 'RGB_INVOICE':
      return caps.supportsAssets && caps.layers.some((l) => l.startsWith('RGB'))
    case 'SPARK':
      return protocol === 'SPARK'
    case 'ARKADE':
      return protocol === 'ARKADE'
    case 'LIQUID':
      return protocol === 'LIQUID'
    default:
      return false
  }
}

export interface SendRoute {
  protocol: ProtocolType
  adapter: IProtocolAdapter
  layer: Layer | null
  /** True when this protocol can pay the destination directly (no swap). */
  direct: boolean
}

export interface SendResolution {
  destination: ClassifiedDestination
  /** Routes that can pay the destination directly, best-first. */
  routes: SendRoute[]
  /** The auto-selected route for lite mode (first direct route), or null. */
  best: SendRoute | null
}

export interface ReceiveRoute {
  protocol: ProtocolType
  adapter: IProtocolAdapter
  layer: Layer
}

/** A send route through a specific rail of a unified payment URI. */
export interface UnifiedSendRoute extends SendRoute {
  /** Which embedded rail this route pays through (lno/lightning/spark/…/onchain). */
  rail: Rail
  /** The payable value for this rail (invoice/offer/address). */
  value: string
}

export interface UnifiedSendResolution {
  /** The parsed unified URI (null when the input was a single raw destination). */
  source: UnifiedReceiveParams | null
  /** Every payable rail×protocol route, ranked by preference (best first). */
  routes: UnifiedSendRoute[]
  /** The auto-selected route (highest-priority direct route) for lite mode, or null. */
  best: UnifiedSendRoute | null
}

export class CrossProtocolRouter {
  constructor(private registry: ProtocolAdapterRegistry) {}

  /** Only adapters that are registered AND connected are eligible to route. */
  private connected(protocol: ProtocolType): IProtocolAdapter | null {
    const a = this.registry.get(protocol)
    return a && a.isConnected() ? a : null
  }

  /**
   * Resolve how to SEND to a destination string. Lite mode uses `.best`; advanced
   * mode can offer the full `.routes` list.
   */
  resolveSend(destination: string): SendResolution {
    const classified = classifyDestination(destination)
    const routes: SendRoute[] = []

    for (const protocol of classified.candidates) {
      const adapter = this.connected(protocol)
      if (!adapter) continue
      // `direct` is verified against the capability manifest, not assumed: lite
      // mode's auto-route must never claim a protocol can pay directly when the
      // manifest disagrees.
      const direct = canSettleDirectly(protocol, classified)
      routes.push({ protocol, adapter, layer: classified.layer, direct })
    }

    // Direct routes first, so `best` is always a genuinely-direct route (or null).
    routes.sort((a, b) => Number(b.direct) - Number(a.direct))
    return { destination: classified, routes, best: routes.find((r) => r.direct) ?? null }
  }

  /**
   * Resolve how to SEND to a UNIFIED payment URI (BIP21/BIP321) carrying several
   * rails at once. Each present rail is matched to the registered+connected
   * protocols that can settle it, then ranked by the user's `preference`, falling
   * back to Lightning-first. `.best` is lite mode's auto-route.
   *
   * A plain (non-`bitcoin:`) string falls back to `resolveSend`, so one entry
   * point handles any pasted destination.
   *
   * BIP353 (₿user@domain) is out of scope: it needs a DNS-over-HTTPS lookup the
   * dependency-free engine doesn't perform. Resolve it to a BIP321 URI in the host.
   */
  resolveUnifiedSend(uri: string, opts?: { preference?: RoutePreference }): UnifiedSendResolution {
    const parsed = parseUnifiedReceiveURI(uri)

    // Not a unified `bitcoin:` URI → treat as a single raw destination.
    if (!parsed) {
      const r = this.resolveSend(uri)
      const routes: UnifiedSendRoute[] = r.routes.map((rt) => ({
        ...rt,
        rail: railOfKind(r.destination.kind),
        value: r.destination.value,
      }))
      return { source: null, routes, best: routes.find((rt) => rt.direct) ?? null }
    }

    // Collect the (rail, payable value) pairs actually present in the URI.
    const railValues: Array<{ rail: Rail; value: string }> = []
    if (parsed.lightningOffer) railValues.push({ rail: 'lno', value: parsed.lightningOffer })
    if (parsed.lightningInvoice) railValues.push({ rail: 'lightning', value: parsed.lightningInvoice })
    if (parsed.sparkAddress) railValues.push({ rail: 'spark', value: parsed.sparkAddress })
    if (parsed.arkadeAddress) railValues.push({ rail: 'ark', value: parsed.arkadeAddress })
    if (parsed.rgbInvoice) railValues.push({ rail: 'rgb', value: parsed.rgbInvoice })
    if (parsed.liquidAddress) railValues.push({ rail: 'liquid', value: parsed.liquidAddress })
    if (parsed.btcAddress) railValues.push({ rail: 'onchain', value: parsed.btcAddress })

    const routes: UnifiedSendRoute[] = []
    for (const { rail, value } of railValues) {
      // Classify each rail's value through the same single source of truth.
      const classified = classifyDestination(value)
      for (const protocol of classified.candidates) {
        const adapter = this.connected(protocol)
        if (!adapter) continue
        routes.push({
          protocol,
          adapter,
          layer: classified.layer,
          direct: canSettleDirectly(protocol, classified),
          rail,
          value,
        })
      }
    }

    // Rank: direct routes first, then by the (per-asset) layer preference, then
    // the default Lightning-first rail order.
    const layerPref = layerPreferenceFor(opts?.preference, parsed.assetId)
    routes.sort((a, b) => {
      if (a.direct !== b.direct) return Number(b.direct) - Number(a.direct)
      return compareByPreference(a, b, layerPref)
    })

    return { source: parsed, routes, best: routes.find((r) => r.direct) ?? null }
  }

  /**
   * Which protocols can RECEIVE on a given layer, e.g. to show the available
   * "receive over Lightning / Spark / on-chain" options.
   */
  resolveReceive(layer: Layer): ReceiveRoute[] {
    const out: ReceiveRoute[] = []
    for (const protocol of this.registry.getSupportedProtocols()) {
      const caps = getCapabilities(protocol)
      if (!caps.layers.includes(layer)) continue
      const adapter = this.connected(protocol)
      if (!adapter) continue
      out.push({ protocol, adapter, layer })
    }
    return out
  }

  /**
   * Which registered+connected protocols hold/transfer a given asset family.
   * `assetFamily`: 'BTC' or a caller-resolved asset id.
   */
  resolveByCapability(predicate: (protocol: ProtocolType) => boolean): IProtocolAdapter[] {
    return this.registry
      .getSupportedProtocols()
      .filter(predicate)
      .map((p) => this.connected(p))
      .filter((a): a is IProtocolAdapter => a != null)
  }
}
