/**
 * Protocol Capability Manifest
 * ----------------------------
 * The backbone of the plugin architecture: protocol *differences* are expressed
 * here as DATA, never as new methods on `IProtocolAdapter`. The cross-protocol
 * router and the lite/advanced UI read this manifest to decide behaviour, so
 * adding or changing one protocol never edits another protocol's code.
 *
 * Rule: when you're tempted to add a method to the contract for a single
 * protocol, add a capability flag here instead.
 */

import { ProtocolType, Layer } from '../types/base'

export interface ProtocolCapabilities {
  protocol: ProtocolType
  /** Layers this protocol can move value on. */
  layers: Layer[]

  // --- Receive / send surface ---
  supportsOnchain: boolean
  supportsLightning: boolean
  /** Can hold/transfer non-BTC assets (RGB assets, Liquid assets, Spark tokens). */
  supportsAssets: boolean
  /** Native swap capability exposed by the protocol/module. */
  supportsSwaps: boolean

  // --- Behavioural quirks the UI/router must know about ---
  /** Spark: transfers are zero-fee. */
  zeroFee: boolean
  /** Receive address is static/reusable for the wallet (Spark static, Arkade). */
  staticReceiveAddress: boolean
  /** Arkade: on-chain "boarding" address to fund the off-chain account. */
  boarding: boolean
  /** Invoices expire (LN / Spark / Liquid-Lightning) → needs a refresh story. */
  invoiceExpiry: boolean
  /** Needs a Lightning channel / inbound liquidity before it can receive over LN. */
  needsChannelLiquidity: boolean

  // --- Provenance / migration ---
  /** The backing WDK package, or null if still on a native SDK / not yet wired. */
  wdkModule: string | null
  /** Maturity of the backing module — drives whether native fallback stays on. */
  maturity: 'beta' | 'stable'
}

/**
 * Single source of truth for what each protocol can do.
 * Keyed by ProtocolType. 'BTC' is the abstract on-chain-only base.
 */
export const PROTOCOL_CAPABILITIES: Record<ProtocolType, ProtocolCapabilities> = {
  BTC: {
    protocol: 'BTC',
    layers: ['BTC_L1'],
    supportsOnchain: true,
    supportsLightning: false,
    supportsAssets: false,
    supportsSwaps: false,
    zeroFee: false,
    staticReceiveAddress: false,
    boarding: false,
    invoiceExpiry: false,
    needsChannelLiquidity: false,
    wdkModule: null,
    maturity: 'stable',
  },
  SPARK: {
    protocol: 'SPARK',
    layers: ['BTC_SPARK', 'SPARK_SPARK', 'BTC_LN'],
    supportsOnchain: true, // via static/single-use deposit addresses
    supportsLightning: true,
    supportsAssets: true, // Spark tokens
    supportsSwaps: false, // swaps handled by the cross-protocol router / Flashnet
    zeroFee: true,
    staticReceiveAddress: true,
    boarding: false,
    invoiceExpiry: true,
    needsChannelLiquidity: false, // Spark has no LN channels to manage
    wdkModule: '@tetherto/wdk-wallet-spark',
    maturity: 'beta',
  },
  ARKADE: {
    protocol: 'ARKADE',
    layers: ['BTC_ARKADE', 'ARKADE_ARKADE', 'BTC_LN'],
    supportsOnchain: true, // boarding
    supportsLightning: true, // via boltz-swap
    supportsAssets: true,
    supportsSwaps: false,
    zeroFee: false,
    staticReceiveAddress: true,
    boarding: true,
    invoiceExpiry: true,
    needsChannelLiquidity: false,
    wdkModule: '@arkade-os/wdk',
    maturity: 'beta',
  },
  RGB_LN: {
    protocol: 'RGB_LN',
    layers: ['BTC_L1', 'BTC_LN', 'RGB_L1', 'RGB_LN'],
    supportsOnchain: true,
    supportsLightning: true,
    supportsAssets: true, // RGB assets (USDT, XAUT)
    supportsSwaps: true, // RGB-LN atomic swaps via the maker
    zeroFee: false,
    staticReceiveAddress: false,
    boarding: false,
    invoiceExpiry: true,
    needsChannelLiquidity: true, // RGB-LN needs channels / LSPS1
    wdkModule: '@kaleidorg/wdk-wallet-rln',
    maturity: 'beta',
  },
  RGB_L1: {
    protocol: 'RGB_L1',
    layers: ['BTC_L1', 'RGB_L1'],
    supportsOnchain: true,
    supportsLightning: false, // rgb-lib is on-chain only — no channels
    supportsAssets: true, // RGB assets (USDT, XAUT) on L1
    supportsSwaps: false, // RGB-LN atomic swaps need the node-backed RGB path
    zeroFee: false,
    staticReceiveAddress: false,
    boarding: false,
    invoiceExpiry: true, // RGB invoices expire
    needsChannelLiquidity: false,
    wdkModule: '@utexo/wdk-wallet-rgb',
    maturity: 'beta',
  },
  LIQUID: {
    protocol: 'LIQUID',
    layers: ['BTC_LIQUID', 'LIQUID_ASSET'],
    supportsOnchain: true, // Liquid is its own L1
    supportsLightning: false, // (Boltz could add this later → flag, not new method)
    supportsAssets: true, // USDt on Liquid = lite-mode "USD"
    supportsSwaps: false,
    zeroFee: false,
    staticReceiveAddress: false,
    boarding: false,
    invoiceExpiry: false,
    needsChannelLiquidity: false,
    wdkModule: '@kaleidorg/wdk-wallet-liquid',
    maturity: 'beta',
  },
}

export function getCapabilities(protocol: ProtocolType): ProtocolCapabilities {
  return PROTOCOL_CAPABILITIES[protocol]
}

/** Protocols that can settle a given layer — used by the cross-protocol router. */
export function protocolsForLayer(layer: Layer): ProtocolType[] {
  return (Object.values(PROTOCOL_CAPABILITIES) as ProtocolCapabilities[])
    .filter((c) => c.layers.includes(layer))
    .map((c) => c.protocol)
}
