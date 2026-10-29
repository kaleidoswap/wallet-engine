/**
 * Platform Ports
 * --------------
 * The engine must never touch platform APIs directly. Each host implements these
 * ports and injects them at startup, so the same engine + adapters run everywhere
 * unchanged.
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

/** Chain a trusted chain-data read targets. */
export type ChainKind = 'bitcoin' | 'liquid'

export interface ChainTxOutput {
  /** Hex scriptPubKey. The field matched against an expected lockup script. */
  scriptPubKey: string
  /**
   * Sats, or undefined for a confidential (blinded) Liquid output whose value the
   * explorer cannot show. Must be present on every Bitcoin output.
   */
  valueSat?: number
}

export interface ChainTxInput {
  txid: string
  vout: number
  /** Witness stack as hex items; empty when the input has none. */
  witness: string[]
}

export interface ChainTransaction {
  txid: string
  /** Raw serialized transaction, hex. */
  hex: string
  vin: ChainTxInput[]
  vout: ChainTxOutput[]
  /** Height of the including block, or undefined while unconfirmed. */
  blockHeight?: number
}

export interface ChainOutspend {
  spent: boolean
  /** Spending transaction, when spent. */
  txid?: string
  /** Input index in the spending transaction, when spent. */
  vin?: number
}

/**
 * Trusted chain data for swap settlement decisions. A host points this at an
 * explorer or node it trusts — never the swap counterparty. A swap venue consults
 * it before any step that reveals a secret, so a provider that lies or is served by
 * the counterparty removes the guarantee. Every method rejects on unavailable or
 * malformed data; none returns a placeholder.
 */
export interface IChainDataProvider {
  /** Current tip height of `chain`. */
  tipHeight(chain: ChainKind): Promise<number>
  /** A transaction by id, or null when the chain source does not know it. */
  getTransaction(chain: ChainKind, txid: string): Promise<ChainTransaction | null>
  /** Spend status of one output. */
  getOutspend(chain: ChainKind, txid: string, vout: number): Promise<ChainOutspend>
}

/** Bundle of ports handed to the engine at initialization. */
export interface PlatformContext {
  storage: IStorageProvider
  runtime: IRuntimeProvider
  /** Optional host logger; engine falls back to a console-backed logger. */
  logger?: Logger
}

/**
 * Console-backed logger used when a host injects none. The single place the engine
 * touches `console`, so the rest of core stays host-agnostic.
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
