/**
 * RGB-only native adapter entry — sub-path export
 * `@kaleidorg/wallet-engine/adapters/rgb`. Pulls only `kaleido-sdk`. The NWC
 * transport is injected via `setNwcRlnClientFactory`, keeping the nostr/relay
 * dependency out of the engine.
 */
export { RgbAdapter } from "./RgbAdapter";
export {
  kaleidoClientManager,
  setNwcRlnClientFactory,
  type KaleidoClientConfig,
  type NwcRlnClientFactory,
  type NwcRlnClientLike,
} from "../lib/kaleido-client-manager";
