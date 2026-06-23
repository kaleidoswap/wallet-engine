/**
 * @kaleidorg/wallet-protocols
 * Shared wallet protocol adapters for Spark, Arkade, RGB, and Flashnet.
 */

// Types
export * from './types/base'
export * from './types/cross-l2'
export type { SparkConfig, SparkTransfer, SparkLightningInvoice, SparkLightningSend, SparkNodeInfo } from './types/spark'
export type { ArkadeConfig, ArkadeVtxo, ArkadeBalance, ArkadeTransaction } from './types/arkade'
export type { RgbConfig, RgbAssetMetadata, RgbChannel, RgbInvoice, RgbTransfer, KaleidoswapQuote, RgbNodeInfo, TradingPair } from './types/rgb'
export * from './types/flashnet'

// Adapter interface
export { type IProtocolAdapter, type BaseProtocolConfig, type ProtocolConfig, type IProtocolAdapterFactory, ProtocolAdapterRegistry } from './adapters/IProtocolAdapter'

// Capability manifest (differences-as-data backbone)
export { PROTOCOL_CAPABILITIES, getCapabilities, protocolsForLayer, type ProtocolCapabilities } from './capabilities'

// Operation-level capability manifest (per-adapter `capabilities` field)
export { PROTOCOL_OPERATIONS, getProtocolOperations, protocolSupportsOperation, type ProtocolCapability } from './capabilities/operations'

// Platform ports (injected per host)
export type { IStorageProvider, IRuntimeProvider, PlatformContext } from './ports'

// Shared constants
export { LIQUID_USDT_ASSET_ID } from './constants'

// NOTE: adapters are deliberately NOT exported from this barrel — they pull
// heavy SDKs / WDK weight an extension host does not want. Import them from the
// opt-in sub-paths instead:
//   @kaleidorg/wallet-protocols/adapters/native  (SDK-backed + client managers)
//   @kaleidorg/wallet-protocols/adapters/wdk     (WDK-backed + createWdkRegistry)
//   @kaleidorg/wallet-protocols/swap             (Kaleidoswap RFQ wrapper)

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
export { ProtocolManager, type ProtocolManagerConfig } from './manager/ProtocolManager'

// Utilities
export { networkTypeToProtocol, protocolToNetworkType } from './utils'
