/**
 * @kaleidorg/wallet-engine
 *
 * The headless multi-protocol wallet abstraction: the IProtocolAdapter
 * contract, ProtocolManager, cross-protocol router, capability manifests,
 * unified receive, lite/advanced disclosure, and platform ports.
 *
 * This root barrel is deliberately ADAPTER-FREE and dependency-light — it does
 * not import any protocol SDK, WDK module, or `kaleido-sdk`. Hosts register
 * their own adapters (or import the bundled ones from the opt-in sub-paths):
 *   - `@kaleidorg/wallet-engine/adapters/native`  (native-SDK adapters)
 *   - `@kaleidorg/wallet-engine/adapters/wdk`     (WDK-backed adapters + registry)
 */

// Types
export * from './types/base'
export * from './types/cross-l2'
export type { SparkConfig, SparkTransfer, SparkLightningInvoice, SparkLightningSend, SparkNodeInfo } from './types/spark'
export type { ArkadeConfig, ArkadeVtxo, ArkadeBalance, ArkadeTransaction } from './types/arkade'
export type { RgbConfig, RgbTransport, RgbAssetMetadata, RgbChannel, RgbInvoice, RgbTransfer, KaleidoswapQuote, RgbNodeInfo, TradingPair } from './types/rgb'
export * from './types/flashnet'

// Engine constants
export { LIQUID_USDT_ASSET_ID } from './constants'

// Adapter interface
export { type IProtocolAdapter, type BaseProtocolConfig, type ProtocolConfig, type IProtocolAdapterFactory, ProtocolAdapterRegistry } from './adapters/IProtocolAdapter'

// Capability manifest (differences-as-data backbone — behavioural quirks)
export { PROTOCOL_CAPABILITIES, getCapabilities, protocolsForLayer, type ProtocolCapabilities } from './capabilities'

// Operation-capability manifest (backs IProtocolAdapter.capabilities)
export {
  type ProtocolCapability,
  PROTOCOL_OPERATION_CAPABILITIES,
  getProtocolCapabilities,
  protocolSupports,
} from './protocol-capabilities'

// Platform ports (injected per host) + the injection seam
export type { IStorageProvider, IRuntimeProvider, PlatformContext } from './ports'
export { initEngine, getPlatformContext, getPlatformContextOptional } from './platform'

// Cross-protocol router (chooses BETWEEN protocols)
export {
  CrossProtocolRouter,
  type SendRoute,
  type SendResolution,
  type ReceiveRoute,
} from './router'
export {
  classifyDestination,
  type ClassifiedDestination,
  type DestinationKind,
} from './router/destination'

// Unified receive QR (single BIP21 with embedded LN/Ark/Spark/Liquid/RGB)
export {
  buildUnifiedReceiveURI,
  parseUnifiedReceiveURI,
  type UnifiedReceiveParams,
} from './receive/unifiedReceive'

// Lite/Advanced disclosure model
export {
  policyFor,
  liteBucketOf,
  aggregateForLite,
  LITE_USD,
  type DisclosureLevel,
  type DisclosurePolicy,
  type LiteBucket,
  type LiteBalances,
} from './disclosure'

// Manager
export { ProtocolManager, type ProtocolManagerConfig, type ProtocolManagerLogger } from './manager/ProtocolManager'

// Utilities
export { networkTypeToProtocol, protocolToNetworkType } from './utils'
