/**
 * Thin logger proxy over the platform `ports` seam. Resolves the active platform
 * logger lazily on each call, so a consumer's `setPlatform()` is honoured even when
 * it runs after these modules are imported. Falls back to `consoleLogger`.
 */

import { getLogger } from "../ports";

export const log = {
  debug: (...args: unknown[]): void => getLogger().debug(...args),
  info: (...args: unknown[]): void => getLogger().info(...args),
  warn: (...args: unknown[]): void => getLogger().warn(...args),
  error: (...args: unknown[]): void => getLogger().error(...args),
};
