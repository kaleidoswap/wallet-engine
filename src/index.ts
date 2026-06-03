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
export { type IProtocolAdapter, type BaseProtocolConfig, type IProtocolAdapterFactory, ProtocolAdapterRegistry } from './adapters/IProtocolAdapter'

// Capability manifest (differences-as-data backbone)
export { PROTOCOL_CAPABILITIES, getCapabilities, protocolsForLayer, type ProtocolCapabilities } from './capabilities'

// Platform ports (injected per host)
export type { IStorageProvider, IRuntimeProvider, PlatformContext } from './ports'

// Adapters (native — being migrated to WDK)
export { SparkAdapter } from './adapters/SparkAdapter'
export { ArkadeAdapter } from './adapters/ArkadeAdapter'
export { RgbAdapter } from './adapters/RgbAdapter'

// Adapters (WDK-backed)
export { SparkWdkAdapter, type SparkAdapterConfig } from './adapters/wdk/SparkWdkAdapter'
export { LiquidWdkAdapter, type LiquidAdapterConfig, LIQUID_USDT_ASSET_ID } from './adapters/wdk/LiquidWdkAdapter'

// Manager
export { ProtocolManager, type ProtocolManagerConfig } from './manager/ProtocolManager'

// Client managers
export { sparkClientManager } from './lib/spark-client-manager'
export { arkadeClientManager, type ArkadePlatformProviders } from './lib/arkade-client-manager'
export { kaleidoClientManager, type KaleidoClientConfig } from './lib/kaleido-client-manager'
export { flashnetClientManager } from './lib/flashnet-client-manager'

// Utilities
export { networkTypeToProtocol, protocolToNetworkType } from './utils'
