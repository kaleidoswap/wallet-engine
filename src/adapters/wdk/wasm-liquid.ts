/**
 * Lean Liquid (WASM) entry — `@kaleidorg/wallet-engine/adapters/wdk/wasm-liquid`.
 *
 * Exposes ONLY the Liquid adapter + the module-injection seam. The full
 * `./adapters/wdk` barrel re-exports every adapter, transitively dragging in heavy
 * native deps (`lwk_wasm`, `sodium-native`, `@utexo/wdk-wallet-rgb`,
 * `@arkade-os/wdk`) a browser / MV3 host doesn't want. Mirrors `./wasm-rgb`.
 */
export {
  LiquidWdkAdapter,
  type LiquidAdapterConfig,
  type LiquidSyncWarning,
  LIQUID_USDT_ASSET_ID,
} from './LiquidWdkAdapter'
export { registerWdkModule, hasWdkModule, type WdkModuleLoader } from './moduleLoader'
