/**
 * Boltz Swap Client Manager
 *
 * Singleton owning the `@kaleidorg/swap-sdk` wasm module and one `BoltzClient`
 * pointed at a KaleidoSwap maker (`/v2`). This is the cross-chain rail — BTC <->
 * L-BTC — distinct from the RFQ rail in `swap/KaleidoswapSwap`.
 *
 * Init is non-blocking (the wasm blob is ~5MB): callers use `getClient()` and fall
 * back when `isInitialized()` is false. Lifecycle: `initialize(config)` on unlock,
 * `dispose()` on lock.
 *
 * The SDK's WebSocket status stream is deliberately NOT wired: its long-lived
 * connection is dropped without notice when an MV3 service worker is evicted, so
 * `BoltzChainSwap` reconciles by polling instead.
 */

import { loadWdkModule } from "../adapters/wdk/moduleLoader";
import { log } from "./log";

/**
 * Chain identity for swap keys, scripts and Esplora access.
 *
 * "signet" is the maker's network and settles on Mutinynet — pair it with
 * Mutinynet chain access, never testnet3. Both encode addresses identically, so a
 * mismatch raises no error: swaps are created on one chain and funded on another.
 */
export type BoltzNetwork = "mainnet" | "testnet" | "signet" | "regtest";

export interface BoltzClientConfig {
  network: BoltzNetwork;
  /**
   * Maker base URL. Omit for the SDK's default for `network` — defined for
   * "signet" and "regtest" only, and throwing otherwise rather than falling back
   * to a third-party maker.
   */
  baseUrl?: string;
  /** Request timeout in seconds, passed to the SDK client. */
  timeoutSecs?: number;
  /**
   * Input for the SDK's `init()`: a URL/Response/BufferSource for the .wasm.
   * Browsers may omit it; Node hosts MUST pass the packaged bytes (Node's `fetch`
   * does not load `file:` URLs).
   */
  wasmInput?: unknown;
}

/** The subset of the SDK module surface this engine uses. */
export interface BoltzSdkModule {
  init(input?: unknown): Promise<void>;
  BoltzClient: {
    new (baseUrl: string, timeoutSecs?: bigint | null): BoltzClientLike;
    forNetwork(network: string): BoltzClientLike;
  };
  SwapScript: {
    fromChain(
      chainKind: string,
      network: string,
      side: string,
      details: unknown,
      ourPubkeyHex: string,
    ): SwapScriptLike;
  };
  SwapMasterKey: {
    fromWalletMnemonic(mnemonic: string, network: string, passphrase?: string): SwapMasterKeyLike;
  };
}

export interface BoltzClientLike {
  chainPairs(): Promise<unknown>;
  createChainSwap(network: string, req: unknown): Promise<unknown>;
  swap(swapId: string): Promise<unknown>;
  chainTxs(id: string): Promise<unknown>;
  /** Chain tips as `{ BTC, "L-BTC" }`, keyed by the maker's own asset symbols. */
  height(): Promise<unknown>;
  free?(): void;
}

export interface SwapScriptLike {
  constructClaim(preimageHex: string, params: unknown): Promise<BtcLikeTransactionLike>;
  constructRefund(params: unknown): Promise<BtcLikeTransactionLike>;
}

export interface BtcLikeTransactionLike {
  broadcast(
    network: string,
    bitcoinEsploraUrl?: string | null,
    liquidEsploraUrl?: string | null,
    esploraTimeoutSecs?: bigint | null,
  ): Promise<string>;
  hex(): string;
  txid(): string;
}

export interface SwapMasterKeyLike {
  masterXpub(): string;
  deriveSwapKey(index: bigint): { publicKey: string; secretKey: string };
  derivePreimage(index: bigint): { preimage: string; sha256: string; hash160: string };
}

const PACKAGE_NAME = "@kaleidorg/swap-sdk";

/**
 * Default maker per network, mirroring the SDK's `BoltzClient.forNetwork`.
 * Duplicated because claim/refund `TxParams` need the base URL as a string and the
 * client does not expose the one it resolved. "mainnet"/"testnet" are absent on
 * purpose: no KaleidoSwap maker runs there, and a default must never fall back to
 * a third-party one.
 */
const DEFAULT_BASE_URL: Partial<Record<BoltzNetwork, string>> = {
  signet: "https://maker.signet.kaleidoswap.com/v2",
  regtest: "http://localhost:9001/v2",
};

/** The maker base URL for a config — explicit if given, else the network default. */
export function resolveBoltzBaseUrl(config: BoltzClientConfig): string {
  if (config.baseUrl) return config.baseUrl;
  const url = DEFAULT_BASE_URL[config.network];
  if (!url) {
    throw new Error(
      `No default KaleidoSwap maker for network "${config.network}" — pass an explicit baseUrl`,
    );
  }
  return url;
}

class BoltzSwapClientManager {
  // Not wallet-scoped: this singleton holds only a public maker/network client.
  // Wallet keys are derived per BoltzChainSwap and never enter this manager.
  private sdk: BoltzSdkModule | null = null;
  private client: BoltzClientLike | null = null;
  private config: BoltzClientConfig | null = null;
  /** Serializes concurrent initialize() calls. */
  private _initPromise: Promise<void> | null = null;
  /** Generation of the in-flight _initPromise. */
  private _initGeneration = 0;
  /** Bumped by dispose() to invalidate any in-flight init. */
  private _generation = 0;

  /**
   * Load the wasm module and construct the maker client. Concurrent calls of the
   * same generation share the in-flight promise; a dispose() bumps the generation
   * so the stale result is discarded.
   */
  initialize(config: BoltzClientConfig): Promise<void> {
    if (this.client) return Promise.resolve();
    if (this._initPromise && this._initGeneration === this._generation) {
      return this._initPromise;
    }
    const generation = this._generation;
    this._initGeneration = generation;
    const promise = this._doInitialize(config, generation).finally(() => {
      if (this._initPromise === promise && this._initGeneration === generation) {
        this._initPromise = null;
      }
    });
    this._initPromise = promise;
    return this._initPromise;
  }

  private async _doInitialize(config: BoltzClientConfig, generation: number): Promise<void> {
    try {
      // @ts-ignore — declared as an optional peer dep; resolved at runtime.
      const mod: BoltzSdkModule = await loadWdkModule(PACKAGE_NAME, () => import(PACKAGE_NAME));
      await mod.init(config.wasmInput);
      const client = config.baseUrl
        ? new mod.BoltzClient(
            config.baseUrl,
            config.timeoutSecs == null ? null : BigInt(config.timeoutSecs),
          )
        : mod.BoltzClient.forNetwork(config.network);
      // dispose() may have run while the wasm was loading — discard if so.
      if (generation !== this._generation) {
        client.free?.();
        log.warn("[BoltzSwapClientManager] Stale init discarded (generation changed during load)");
        return;
      }
      this.sdk = mod;
      this.client = client;
      this.config = config;
      log.info(`[BoltzSwapClientManager] Initialized (network=${config.network})`);
    } catch (error: unknown) {
      if (generation === this._generation) {
        this.sdk = null;
        this.client = null;
        this.config = null;
      }
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(
        `[BoltzSwapClientManager] Failed to initialize: ${msg}. Chain swaps unavailable until reconnect.`,
      );
      throw error;
    }
  }

  isInitialized(): boolean {
    return this.client !== null;
  }

  /** @throws if not initialized */
  getClient(): BoltzClientLike {
    if (!this.client) {
      throw new Error("Boltz swap client not initialized. Call initialize() first.");
    }
    return this.client;
  }

  /** @throws if not initialized */
  getSdk(): BoltzSdkModule {
    if (!this.sdk) {
      throw new Error("Boltz swap SDK not initialized. Call initialize() first.");
    }
    return this.sdk;
  }

  /** @throws if not initialized */
  getConfig(): BoltzClientConfig {
    if (!this.config) {
      throw new Error("Boltz swap client not initialized. Call initialize() first.");
    }
    return this.config;
  }

  /**
   * Release the client. Safe when never initialized. Does not abandon in-flight
   * swaps — those live in the store and resume via `BoltzChainSwap.listPending()`.
   */
  dispose(): void {
    this._generation++;
    if (!this.client) return;
    try {
      this.client.free?.();
    } catch (error: unknown) {
      log.warn("[BoltzSwapClientManager] Error during dispose:", error);
    } finally {
      this.client = null;
      this.sdk = null;
      this.config = null;
    }
  }
}

export const boltzSwapClientManager = new BoltzSwapClientManager();
