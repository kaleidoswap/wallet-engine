/**
 * Arkade Swaps Client Manager
 *
 * Singleton that owns an `ArkadeSwaps` instance from `@arkade-os/boltz-swap`.
 * Provides Boltz-based swaps between Arkade VTXOs and Lightning / on-chain BTC.
 *
 * Initialization is non-blocking: callers should attempt to use the client
 * via `getClient()` and gracefully fall back when `isInitialized()` is false
 * (e.g. on cold-start before the post-unlock init has finished).
 *
 * Lifecycle:
 *   - Arkade adapter connect  → `initialize(wallet)`
 *   - Arkade adapter disconnect → `dispose()`
 *
 * The default repository is IndexedDB-backed so pending submarine / reverse /
 * chain swaps survive a service-worker restart and are auto-claimed/refunded by
 * the embedded `SwapManager`. Non-browser hosts (React Native) must inject a
 * platform-appropriate `swapRepository` via `initialize(wallet, { swapRepository })`.
 */

import { ArkadeSwaps, IndexedDbSwapRepository } from "@arkade-os/boltz-swap";
import type { IWallet } from "@arkade-os/sdk";
import { log } from "./log";

type SwapsClient = InstanceType<typeof ArkadeSwaps>;

/** Default IndexedDB database name for swap persistence. */
const DEFAULT_DB_NAME = "kaleidoswap-arkade-swaps";

export interface ArkadeSwapsInitOptions {
  dbName?: string;
  /** Platform-supplied swap repository (required off-browser, e.g. React Native). */
  swapRepository?: unknown;
}

class ArkadeSwapsClientManager {
  private client: SwapsClient | null = null;
  /** Serializes concurrent initialize() calls. */
  private _initPromise: Promise<void> | null = null;
  /** Generation of the in-flight _initPromise. */
  private _initGeneration = 0;
  /** Bumped by dispose() to invalidate any in-flight init. */
  private _generation = 0;

  /**
   * Initialize the swaps client with a connected Arkade wallet.
   * Concurrent calls that belong to the same generation share the in-flight
   * promise. A dispose() between calls bumps the generation so the old
   * in-flight is treated as stale and a fresh init is started.
   */
  initialize(wallet: IWallet, opts?: ArkadeSwapsInitOptions): Promise<void> {
    if (this.client) return Promise.resolve();
    // Reuse in-flight promise only if it belongs to the current generation.
    if (this._initPromise && this._initGeneration === this._generation) {
      return this._initPromise;
    }
    const generation = this._generation;
    this._initGeneration = generation;
    const promise = this._doInitialize(wallet, generation, opts).finally(() => {
      // Only clear if this promise is still the active one (prevents stale
      // promises from clearing a newer in-flight init).
      if (this._initPromise === promise && this._initGeneration === generation) {
        this._initPromise = null;
      }
    });
    this._initPromise = promise;
    return this._initPromise;
  }

  private async _doInitialize(
    wallet: IWallet,
    generation: number,
    opts?: ArkadeSwapsInitOptions,
  ): Promise<void> {
    try {
      const swapRepository =
        opts?.swapRepository ?? new IndexedDbSwapRepository(opts?.dbName ?? DEFAULT_DB_NAME);
      const client = await ArkadeSwaps.create({
        wallet,
        // The SwapManager monitors pending swaps in the background and
        // auto-claims reverse swaps / auto-refunds failed submarine swaps.
        swapManager: true,
        swapRepository,
      } as unknown as Parameters<typeof ArkadeSwaps.create>[0]);
      // Guard: dispose() may have been called while ArkadeSwaps.create was
      // awaited. If the generation has changed the wallet is stale — discard.
      if (generation !== this._generation) {
        try {
          await client.dispose();
        } catch {
          /* ignore cleanup errors */
        }
        log.warn(
          "[ArkadeSwapsClientManager] Stale init discarded (generation changed during ArkadeSwaps.create)",
        );
        return;
      }
      this.client = client;
      log.info("[ArkadeSwapsClientManager] Initialized (Boltz swaps ready)");
    } catch (error: unknown) {
      // Only clear client if this init's generation is still current (prevents
      // a stale failed init from clearing a newer successful client).
      if (generation === this._generation) {
        this.client = null;
      }
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(
        `[ArkadeSwapsClientManager] Failed to initialize: ${msg}. Lightning swaps will be unavailable until reconnect.`,
      );
      throw error;
    }
  }

  isInitialized(): boolean {
    return this.client !== null;
  }

  /** @throws if not initialized */
  getClient(): SwapsClient {
    if (!this.client) {
      throw new Error("Arkade swaps client not initialized. Call initialize() first.");
    }
    return this.client;
  }

  /**
   * Stop the embedded SwapManager and release resources. Safe to call when
   * the client was never initialized.
   */
  async dispose(): Promise<void> {
    // Bump generation first so any in-flight _doInitialize sees the change
    // even if ArkadeSwaps.create() has not returned yet.
    this._generation++;
    if (!this.client) return;
    try {
      await this.client.dispose();
    } catch (error: unknown) {
      log.warn("[ArkadeSwapsClientManager] Error during dispose:", error);
    } finally {
      this.client = null;
    }
  }
}

export const arkadeSwapsClientManager = new ArkadeSwapsClientManager();
