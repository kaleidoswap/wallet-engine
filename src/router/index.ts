/**
 * CrossProtocolRouter
 * -------------------
 * Sits ON TOP of the adapters and chooses BETWEEN protocols. Given a send
 * destination or a receive intent, it returns the protocol(s) that can fulfil it,
 * filtered to what's actually registered and connected. This is the layer that
 * makes lite mode possible: it auto-selects the route so the UI never has to.
 *
 * It reads the capability manifest (differences-as-data) + the destination
 * classifier — never the adapters' internals.
 */

import { ProtocolAdapterRegistry, IProtocolAdapter } from '../adapters/IProtocolAdapter'
import { ProtocolType, Layer } from '../types/base'
import { getCapabilities } from '../capabilities'
import { classifyDestination, ClassifiedDestination } from './destination'

/**
 * Whether `protocol` can pay `dest` DIRECTLY (no swap), per the capability
 * manifest. Reads capability flags rather than exact layer strings so a protocol
 * that reaches a surface by a different path (e.g. Spark paying on-chain via a
 * deposit/exit) is still recognised.
 */
function canSettleDirectly(protocol: ProtocolType, dest: ClassifiedDestination): boolean {
  const caps = getCapabilities(protocol)
  switch (dest.kind) {
    case 'BOLT11':
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

export class CrossProtocolRouter {
  constructor(private registry: ProtocolAdapterRegistry) {}

  /** Only adapters that are registered AND connected are eligible to route. */
  private connected(protocol: ProtocolType): IProtocolAdapter | null {
    const a = this.registry.get(protocol)
    return a && a.isConnected() ? a : null
  }

  /**
   * Resolve how to SEND to a destination string.
   * Lite mode uses `.best`; advanced mode can offer the full `.routes` list.
   */
  resolveSend(destination: string): SendResolution {
    const classified = classifyDestination(destination)
    const routes: SendRoute[] = []

    for (const protocol of classified.candidates) {
      const adapter = this.connected(protocol)
      if (!adapter) continue
      // `direct` is verified against the capability manifest, not assumed: a
      // candidate is only a direct route if its protocol actually supports the
      // surface this destination settles on. Lite mode's auto-route (`best`)
      // must never claim a protocol can pay directly when the manifest disagrees.
      const direct = canSettleDirectly(protocol, classified)
      routes.push({ protocol, adapter, layer: classified.layer, direct })
    }

    // Direct routes first, so `best` is always a genuinely-direct route (or null).
    routes.sort((a, b) => Number(b.direct) - Number(a.direct))
    return { destination: classified, routes, best: routes.find((r) => r.direct) ?? null }
  }

  /**
   * Resolve which protocols can RECEIVE on a given layer (e.g. show the user
   * the available "receive over Lightning / Spark / on-chain" options).
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
   * `assetFamily`: 'BTC' or a specific asset id resolved by the caller to a protocol.
   */
  resolveByCapability(predicate: (protocol: ProtocolType) => boolean): IProtocolAdapter[] {
    return this.registry
      .getSupportedProtocols()
      .filter(predicate)
      .map((p) => this.connected(p))
      .filter((a): a is IProtocolAdapter => a != null)
  }
}
