/**
 * Flashnet adapter entry — AMM (Flashnet) + cross-chain bridge (Orchestra).
 *
 * Opt-in sub-path export: `@kaleidorg/wallet-engine/adapters/flashnet`. Pulls
 * `@flashnet/sdk` (via the Flashnet client manager) — not the Arkade/RGB SDKs.
 * The Orchestra REST client carries no SDK; its API key is consumer-injected
 * via `setOrchestraApiKey()` (kept out of the engine, which has no build-time env).
 *
 * `flashnetClientManager.initialize()` needs a `SparkWallet`, so this composes
 * with `@kaleidorg/wallet-engine/adapters/spark`.
 */
export { flashnetClientManager } from '../lib/flashnet-client-manager'
export * from '../lib/orchestra-client'
