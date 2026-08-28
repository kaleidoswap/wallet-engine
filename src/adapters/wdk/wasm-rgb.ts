/**
 * Lean RGB-L1 (WASM) entry — `@kaleidorg/wallet-engine/adapters/wdk/wasm-rgb`.
 *
 * Exposes ONLY the wasm RGB-L1 backing + the module-injection seam, so a browser /
 * MV3 host can bundle just this adapter (+ rgb-lib-wasm, which it injects) without
 * resolving the heavy native deps the full `./adapters/wdk` barrel pulls in.
 */
export { RgbLibWasmAdapter, type RgbLibWasmAdapterConfig } from './RgbLibWasmAdapter'
export { registerWdkModule, hasWdkModule, type WdkModuleLoader } from './moduleLoader'
