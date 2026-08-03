/**
 * Lean Liquid (WASM) entry — `@kaleidorg/wallet-engine/adapters/wdk/wasm-liquid`.
 *
 * Exposes ONLY the Liquid adapter + the module-injection seam, with no static
 * reference to the other WDK adapters (Spark/RLN/native-RGB/RGB-L1/Arkade) or
 * `createWdkRegistry`. The full `./adapters/wdk` barrel statically re-exports
 * every adapter, which transitively drags in heavy/native deps (`lwk_wasm`,
 * `sodium-native`, `@utexo/wdk-wallet-rgb`, `@arkade-os/wdk`) that a browser /
 * MV3 service worker host doesn't want. Importing from this lean entry lets such
 * a host bundle just the Liquid adapter (+ `lwk_wasm`, which it instantiates and
 * injects via `registerWdkModule`) without resolving those.
 *
 * Mirrors `./wasm-rgb` (the RGB-L1 analogue).
 */
export {
  LiquidWdkAdapter,
  type LiquidAdapterConfig,
  type LiquidSyncWarning,
  LIQUID_USDT_ASSET_ID,
} from './LiquidWdkAdapter'
export { registerWdkModule, hasWdkModule, type WdkModuleLoader } from './moduleLoader'
