/**
 * Thin logger proxy over the platform `ports` seam.
 *
 * Ported Arkade modules use `log.info(...)` / `log.warn(...)` call sites. This
 * proxy resolves the active platform logger lazily on each call so that a
 * consumer's `setPlatform()` (extension / React Native) is honoured even when
 * it runs after these modules are imported. Falls back to `consoleLogger`.
 */

import { getLogger } from "../ports";

export const log = {
  debug: (...args: unknown[]): void => getLogger().debug(...args),
  info: (...args: unknown[]): void => getLogger().info(...args),
  warn: (...args: unknown[]): void => getLogger().warn(...args),
  error: (...args: unknown[]): void => getLogger().error(...args),
};
