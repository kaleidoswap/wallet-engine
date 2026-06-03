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

/** Bundle of ports handed to the engine at initialization. */
export interface PlatformContext {
  storage: IStorageProvider
  runtime: IRuntimeProvider
}
