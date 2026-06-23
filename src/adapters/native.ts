/**
 * Native adapters (SDK-backed) + their client managers.
 *
 * Opt-in sub-path export: `@kaleidorg/wallet-engine/adapters/native`. These
 * statically pull heavy SDKs (kaleido-sdk, spark-sdk, …) so they are kept OUT
 * of the main barrel — hosts that ship their own adapters import only the
 * abstraction from the root and never this module.
 */
export { SparkAdapter } from './SparkAdapter'
export { ArkadeAdapter } from './ArkadeAdapter'
export { RgbAdapter } from './RgbAdapter'

export { sparkClientManager } from '../lib/spark-client-manager'
export { arkadeClientManager, type ArkadePlatformProviders } from '../lib/arkade-client-manager'
export { kaleidoClientManager, type KaleidoClientConfig } from '../lib/kaleido-client-manager'
export { flashnetClientManager } from '../lib/flashnet-client-manager'
