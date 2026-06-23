/**
 * WDK-backed adapters, registry, module loader, and the Kaleidoswap RFQ swap
 * wrapper — opt-in sub-path (`@kaleidorg/wallet-engine/adapters/wdk`).
 *
 * Importing this references the WDK packages (loaded lazily inside each
 * adapter's `connect()` via the module loader). The root barrel does NOT export
 * these, keeping the core abstraction free of WDK weight.
 */

export { SparkWdkAdapter, type SparkAdapterConfig } from './SparkWdkAdapter'
export { LiquidWdkAdapter, type LiquidAdapterConfig, LIQUID_USDT_ASSET_ID } from './LiquidWdkAdapter'
export { RlnWdkAdapter, type RlnAdapterConfig } from './RlnWdkAdapter'
export { ArkadeWdkAdapter, type ArkadeAdapterConfig } from './ArkadeWdkAdapter'
export { createWdkRegistry, type WdkRegistryOptions } from '../../registry/createWdkRegistry'
export { registerWdkModule, hasWdkModule, type WdkModuleLoader } from './moduleLoader'

// Kaleidoswap RFQ swap wrapper (binds the WDK swap module to an account)
export {
  KaleidoswapSwap,
  type KaleidoswapSwapConfig,
  type SwapQuoteRequest,
  type SwapExecuteRequest,
} from '../../swap/KaleidoswapSwap'
