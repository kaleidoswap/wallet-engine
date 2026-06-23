/**
 * Platform injection seam.
 * ------------------------
 * The engine never touches platform APIs directly (storage, CSPRNG, clock).
 * The host builds a `PlatformContext` (see `./ports`) and injects it once at
 * startup via `initEngine(ctx)`; engine/adapter code that needs a platform
 * capability resolves it through `getPlatformContext()`.
 *
 * Kept as a module-level singleton so code that isn't manager-scoped (adapters,
 * client managers) can reach the host without threading the context through
 * every call. `ProtocolManager` also accepts a `platform` in its config and
 * falls back to this singleton.
 */

import type { PlatformContext } from './ports'

let current: PlatformContext | null = null

/** Install the host platform context. Call once at host startup. */
export function initEngine(platform: PlatformContext): void {
  current = platform
}

/**
 * Get the installed platform context, throwing if the host never called
 * `initEngine`. Use this from code that genuinely needs storage/RNG/clock.
 */
export function getPlatformContext(): PlatformContext {
  if (!current) {
    throw new Error(
      'wallet-engine: platform context not initialized — call initEngine(ctx) at host startup'
    )
  }
  return current
}

/** Non-throwing variant for code that can degrade when no host is installed. */
export function getPlatformContextOptional(): PlatformContext | null {
  return current
}
