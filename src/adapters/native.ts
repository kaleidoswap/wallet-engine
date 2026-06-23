/**
 * Native-SDK adapters and client managers — opt-in sub-path
 * (`@kaleidorg/wallet-engine/adapters/native`).
 *
 * Importing this pulls the native SDKs + `kaleido-sdk`. The root barrel
 * deliberately does NOT export these, so hosts that bring their own adapters
 * (e.g. the browser extension) get the abstraction without this weight.
 */

export { SparkAdapter } from './SparkAdapter'
export { ArkadeAdapter } from './ArkadeAdapter'
export { RgbAdapter } from './RgbAdapter'

export { sparkClientManager } from '../lib/spark-client-manager'
export { arkadeClientManager, type ArkadePlatformProviders } from '../lib/arkade-client-manager'
export { kaleidoClientManager, type KaleidoClientConfig } from '../lib/kaleido-client-manager'
export { flashnetClientManager } from '../lib/flashnet-client-manager'
