/**
 * WDK-backed adapters + the WDK registry factory + module loader seam.
 *
 * Opt-in sub-path export: `@kaleidorg/wallet-engine/adapters/wdk`. WDK
 * modules are lazy-loaded via `loadWdkModule`, but these adapters are still
 * kept out of the main barrel so hosts that supply their own adapters never
 * reference them.
 */
export { SparkWdkAdapter, type SparkAdapterConfig } from './SparkWdkAdapter'
export { LiquidWdkAdapter, type LiquidAdapterConfig, LIQUID_USDT_ASSET_ID } from './LiquidWdkAdapter'
export { RlnWdkAdapter, type RlnAdapterConfig } from './RlnWdkAdapter'
export { RgbLibWdkAdapter, type RgbLibAdapterConfig } from './RgbLibWdkAdapter'
export { RgbLibWasmAdapter, type RgbLibWasmAdapterConfig } from './RgbLibWasmAdapter'
export { ArkadeWdkAdapter, type ArkadeAdapterConfig } from './ArkadeWdkAdapter'
export { createWdkRegistry, type WdkRegistryOptions } from '../../registry/createWdkRegistry'
export { registerWdkModule, hasWdkModule, type WdkModuleLoader } from './moduleLoader'
