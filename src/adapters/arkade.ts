/**
 * Arkade-only native adapter entry.
 *
 * Opt-in sub-path export: `@kaleidorg/wallet-engine/adapters/arkade`. Unlike
 * `adapters/native` (which statically pulls Spark + RGB + kaleido SDKs), this
 * entry pulls ONLY `@arkade-os/sdk` (+ optional `@arkade-os/boltz-swap`), so a
 * host that just wants Arkade doesn't bundle the other protocols' SDKs.
 *
 * The platform-agnostic VTXO lifecycle + delegator helpers + settings live in
 * the SDK-free root barrel (`@kaleidorg/wallet-engine`).
 */
export { ArkadeAdapter } from './ArkadeAdapter'
export { arkadeClientManager, type ArkadePlatformProviders } from '../lib/arkade-client-manager'
export {
  arkadeSwapsClientManager,
  type ArkadeSwapsInitOptions,
} from '../lib/arkade-swaps-client-manager'
