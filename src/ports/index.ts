/**
 * Platform Ports
 * --------------
 * The engine must never touch platform APIs directly. Each host (React Native,
 * browser extension, Node) implements these ports and injects them at startup,
 * so the same engine + adapters run everywhere unchanged.
 */

/** Persistent key/value storage. RN → SecureStore/MMKV; extension → chrome.storage. */
export interface IStorageProvider {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
  keys(): Promise<string[]>
}

/** Host capabilities the engine needs but that vary per platform. */
export interface IRuntimeProvider {
  /** Host identifier — drives diagnostics and WDK export-condition selection. */
  readonly host: 'react-native' | 'extension' | 'node' | 'web'
  /** Secure random bytes from the platform CSPRNG. */
  randomBytes(length: number): Uint8Array
  /** Epoch millis — injectable so tests/replay can be deterministic. */
  now(): number
}

/** Leveled logger. Hosts inject their own (extension → redacting ring buffer). */
export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Bundle of ports handed to the engine at initialization. */
export interface PlatformContext {
  storage: IStorageProvider
  runtime: IRuntimeProvider
  /** Optional host logger; engine falls back to a console-backed logger. */
  logger?: Logger
}

/**
 * Console-backed logger used when a host injects none. Kept as the single place
 * the engine touches `console`, so the rest of core stays host-agnostic.
 */
export const consoleLogger: Logger = {
  debug: (...a) => console.debug(...a),
  info: (...a) => console.info(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
}

let platform: PlatformContext | null = null

/** Inject the host's platform ports once at startup. */
export function setPlatform(ctx: PlatformContext): void {
  platform = ctx
}

/** The injected platform context, or null if the host never called setPlatform. */
export function getPlatform(): PlatformContext | null {
  return platform
}

/** The active logger: injected host logger if present, else the console logger. */
export function getLogger(): Logger {
  return platform?.logger ?? consoleLogger
}
