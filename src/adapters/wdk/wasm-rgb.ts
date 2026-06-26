/**
 * Lean RGB-L1 (WASM) entry — `@kaleidorg/wallet-engine/adapters/wdk/wasm-rgb`.
 *
 * Exposes ONLY the wasm RGB-L1 backing + the module-injection seam, with no
 * static reference to the other WDK adapters (Spark/Liquid/RLN/native-RGB/
 * Arkade) or `createWdkRegistry`. The full `./adapters/wdk` barrel statically
 * re-exports every adapter, which transitively drags in heavy/native deps
 * (`lwk_wasm`, `sodium-native`, `@utexo/wdk-wallet-rgb`, `@arkade-os/wdk`) that
 * a browser / MV3 service worker host doesn't have. Importing from this lean
 * entry lets such a host bundle just the wasm adapter (+ rgb-lib-wasm, which it
 * injects) without resolving those.
 */
export { RgbLibWasmAdapter, type RgbLibWasmAdapterConfig } from './RgbLibWasmAdapter'
export { registerWdkModule, hasWdkModule, type WdkModuleLoader } from './moduleLoader'
