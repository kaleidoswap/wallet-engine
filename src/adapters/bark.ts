/**
 * Bark-only adapter entry — sub-path export
 * `@kaleidorg/wallet-engine/adapters/bark`. Pulls ONLY `@secondts/bark`, whose
 * wasm the host instantiates before `connect()` (see `bark-client-manager`).
 */
export { BarkAdapter } from './BarkAdapter'
export { barkClientManager, setBarkModuleLoader } from '../lib/bark-client-manager'
export type { BarkConfig, BarkBalance, BarkMaintenanceReport } from '../types/bark'
