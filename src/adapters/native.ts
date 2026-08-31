/**
 * Native adapters (SDK-backed) + their client managers — sub-path export
 * `@kaleidorg/wallet-engine/adapters/native`. These statically pull heavy SDKs, so
 * they are kept OUT of the main barrel.
 */
export { SparkAdapter } from './SparkAdapter'
export { ArkadeAdapter } from './ArkadeAdapter'
export { RgbAdapter } from './RgbAdapter'

export { sparkClientManager } from '../lib/spark-client-manager'
export { arkadeClientManager, type ArkadePlatformProviders } from '../lib/arkade-client-manager'
export {
  arkadeSwapsClientManager,
  type ArkadeSwapsInitOptions,
} from '../lib/arkade-swaps-client-manager'
export {
  arkadeIntentsClientManager,
  type ArkadeIntentsInitOptions,
  type ArkadeIntentsVenueLike,
} from '../lib/arkade-intents-client-manager'
export { kaleidoClientManager, type KaleidoClientConfig } from '../lib/kaleido-client-manager'
export { flashnetClientManager } from '../lib/flashnet-client-manager'
