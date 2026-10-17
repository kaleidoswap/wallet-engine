/**
 * Arkade-only native adapter entry — sub-path export
 * `@kaleidorg/wallet-engine/adapters/arkade`. Unlike `adapters/native` (which
 * statically pulls Spark + RGB + kaleido SDKs), this pulls ONLY `@arkade-os/sdk`.
 * The platform-agnostic VTXO lifecycle helpers live in the SDK-free root barrel.
 */
export { ArkadeAdapter } from './ArkadeAdapter'
export { arkadeClientManager, type ArkadePlatformProviders } from '../lib/arkade-client-manager'
export {
  cleanupLegacyArkadeSwapsDb,
  isFinalLegacySwap,
  LEGACY_ARKADE_SWAPS_DB,
  type LegacyArkadeSwapsCleanup,
} from '../lib/legacy-arkade-swaps-cleanup'
export {
  arkadeIntentsClientManager,
  type ArkadeIntentsInitOptions,
  type ArkadeIntentsVenueLike,
} from '../lib/arkade-intents-client-manager'
