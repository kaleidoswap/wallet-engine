/**
 * @kaleidorg/wallet-protocols
 * Shared wallet protocol adapters for Spark, Arkade, RGB, and Flashnet.
 */

// Types
export * from './types/base'
export * from './types/cross-l2'
export type { SparkConfig, SparkTransfer, SparkLightningInvoice, SparkLightningSend, SparkNodeInfo } from './types/spark'
export type { ArkadeConfig, ArkadeVtxo, ArkadeBalance, ArkadeTransaction } from './types/arkade'
export type { RgbConfig, RgbTransport, RgbAssetMetadata, RgbChannel, RgbInvoice, RgbTransfer, KaleidoswapQuote, RgbNodeInfo, TradingPair } from './types/rgb'
export * from './types/flashnet'

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

// Platform ports (injected per host)
export type { IStorageProvider, IRuntimeProvider, PlatformContext } from './ports'

// Adapters (native — being migrated to WDK)
export { SparkAdapter } from './adapters/SparkAdapter'
export { ArkadeAdapter } from './adapters/ArkadeAdapter'
export { RgbAdapter } from './adapters/RgbAdapter'

// Adapters (WDK-backed)
export { SparkWdkAdapter, type SparkAdapterConfig } from './adapters/wdk/SparkWdkAdapter'
export { LiquidWdkAdapter, type LiquidAdapterConfig, LIQUID_USDT_ASSET_ID } from './adapters/wdk/LiquidWdkAdapter'
export { RlnWdkAdapter, type RlnAdapterConfig } from './adapters/wdk/RlnWdkAdapter'
export { ArkadeWdkAdapter, type ArkadeAdapterConfig } from './adapters/wdk/ArkadeWdkAdapter'
export { createWdkRegistry, type WdkRegistryOptions } from './registry/createWdkRegistry'

// WDK module loader (RN injects static require; other hosts use dynamic import)
export { registerWdkModule, hasWdkModule, type WdkModuleLoader } from './adapters/wdk/moduleLoader'

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

// Kaleidoswap RFQ swap wrapper
export {
  KaleidoswapSwap,
  type KaleidoswapSwapConfig,
  type SwapQuoteRequest,
  type SwapExecuteRequest,
} from './swap/KaleidoswapSwap'

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

// Client managers
export { sparkClientManager } from './lib/spark-client-manager'
export { arkadeClientManager, type ArkadePlatformProviders } from './lib/arkade-client-manager'
export { kaleidoClientManager, type KaleidoClientConfig } from './lib/kaleido-client-manager'
export { flashnetClientManager } from './lib/flashnet-client-manager'

// Utilities
export { networkTypeToProtocol, protocolToNetworkType } from './utils'
