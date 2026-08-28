/**
 * WDK-backed adapters + the registry factory + module loader seam. Sub-path export
 * `@kaleidorg/wallet-engine/adapters/wdk`. WDK modules are lazy-loaded, but these
 * adapters stay out of the main barrel so hosts supplying their own never reference
 * them.
 */
export { SparkWdkAdapter, type SparkAdapterConfig } from './SparkWdkAdapter'
export {
  LiquidWdkAdapter,
  type LiquidAdapterConfig,
  type LiquidSyncWarning,
  type LiquidSecretsStore,
  type LiquidOutputSecretsRecord,
  LIQUID_USDT_ASSET_ID,
} from './LiquidWdkAdapter'
export { RlnWdkAdapter, type RlnAdapterConfig } from './RlnWdkAdapter'
export { RgbLibWdkAdapter, type RgbLibAdapterConfig } from './RgbLibWdkAdapter'
export { RgbLibWasmAdapter, type RgbLibWasmAdapterConfig } from './RgbLibWasmAdapter'
export { ArkadeWdkAdapter, type ArkadeAdapterConfig } from './ArkadeWdkAdapter'
export { createWdkRegistry, type WdkRegistryOptions } from '../../registry/createWdkRegistry'
export { registerWdkModule, hasWdkModule, type WdkModuleLoader } from './moduleLoader'
