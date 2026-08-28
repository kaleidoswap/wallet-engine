/**
 * Flashnet adapter entry — AMM (Flashnet) + cross-chain bridge (Orchestra).
 * Sub-path export `@kaleidorg/wallet-engine/adapters/flashnet`. Pulls
 * `@flashnet/sdk` only; the Orchestra REST client carries no SDK and takes its API
 * key via `setOrchestraApiKey()`. `flashnetClientManager.initialize()` needs a
 * `SparkWallet`, so this composes with `adapters/spark`.
 */
export { flashnetClientManager } from '../lib/flashnet-client-manager'
export * from '../lib/orchestra-client'
// Re-export the SDK error guard so consumers classify Flashnet errors through
// the engine (no direct `@flashnet/sdk` dependency in the host).
export { isFlashnetError } from '@flashnet/sdk'
