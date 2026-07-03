/**
 * RGB-only native adapter entry.
 *
 * Opt-in sub-path export: `@kaleidorg/wallet-engine/adapters/rgb`. Pulls only
 * `kaleido-sdk` (RGB Lightning node + Kaleidoswap maker) — not the Arkade/Spark
 * SDKs. The NWC transport is injected by the consumer via `setNwcRlnClientFactory`
 * (keeps the nostr/relay dependency out of the engine).
 */
export { RgbAdapter } from "./RgbAdapter";
export {
  kaleidoClientManager,
  setNwcRlnClientFactory,
  type KaleidoClientConfig,
  type NwcRlnClientFactory,
  type NwcRlnClientLike,
} from "../lib/kaleido-client-manager";
