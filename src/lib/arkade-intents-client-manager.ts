/**
 * Arkade Intents Client Manager
 *
 * Singleton owning an `ArkadeIntentsVenue` from `@kaleidorg/swap-sdk/arkade` — the
 * Arkade Intents RFQ routes plus the intra-Arkade asset-swap covenant. Mirrors
 * `arkadeSwapsClientManager`: non-blocking init, generation-counted dispose.
 *
 * Deliberate differences from the Boltz manager:
 *  - The venue resolves through the WDK module loader with a non-literal dynamic
 *    import fallback: the subpath ships in swap-sdk >= 0.3.0 while the peer range
 *    still admits older versions, so a literal specifier would break `tsc`.
 *  - The RFQ `transport` is host-supplied and opaque — building one needs the
 *    solver's card and a Nostr stack, product decisions the engine doesn't own.
 *  - The venue owns no timers: the host drives `getVenue().reconcile()`.
 *
 * The venue requires `@arkade-os/sdk` >= 0.4.60 (the `VHTLC.ScriptV2` era); the
 * engine only passes the wallet through, so the pin is the host's to own.
 */

import type { IWallet } from "@arkade-os/sdk";
import { loadWdkModule } from "../adapters/wdk/moduleLoader";
import { ArkadeIntentsStore, type ArkadeIntentsRecord } from "../swap/arkade-intents-store";
import { log } from "./log";

/** The venue module's subpath — also the module-loader registry key. */
const VENUE_MODULE = "@kaleidorg/swap-sdk/arkade";

/**
 * Structural view of the venue the engine relies on. Canonical types live in
 * `@kaleidorg/swap-sdk/arkade`; hosts wanting full typing import and cast.
 */
export interface ArkadeIntentsVenueLike {
  prepareLightningSend(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  prepareLightningReceive(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  notifyFunded(id: string, fundingTxid?: string): Promise<ArkadeIntentsRecord>;
  claimReceive(id: string, options?: Record<string, unknown>): Promise<ArkadeIntentsRecord>;
  refundSend(id: string): Promise<ArkadeIntentsRecord>;
  prepareAssetSwap(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  notifyAssetSwapFunded(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  cancelAssetSwap(fundingTxid: string): Promise<Record<string, unknown>>;
  reconcile(): Promise<{
    settled: string[];
    refunded: string[];
    cancelled: string[];
    needsRecovery: string[];
    pending: string[];
    errors: { id: string; error: unknown }[];
  }>;
}

export interface ArkadeIntentsInitOptions {
  /** The Arkade server the venue derives contracts against. */
  arkServerUrl: string;
  /**
   * RFQ transport from the pinned solver's card. Opaque to the engine; closed
   * best-effort on dispose.
   */
  transport: unknown;
  /** Override the platform-storage-backed record store. */
  store?: unknown;
  /**
   * Ecosystem `AssetSwapRepository` enabling the intra-Arkade asset-swap route
   * (e.g. `IndexedDbAssetSwapRepository` from `@arkade-os/swap`).
   */
  assetSwapRepository?: unknown;
}

class ArkadeIntentsClientManager {
  private venue: ArkadeIntentsVenueLike | null = null;
  private transport: unknown = null;
  /** Serializes concurrent initialize() calls. */
  private _initPromise: Promise<void> | null = null;
  /** Generation of the in-flight _initPromise. */
  private _initGeneration = 0;
  /** Bumped by dispose() to invalidate any in-flight init. */
  private _generation = 0;

  /**
   * Initialize the venue with a connected Arkade wallet. Concurrent calls of the
   * same generation share the in-flight promise; a dispose() bumps the generation so
   * a stale init is discarded.
   */
  async initialize(wallet: IWallet, options: ArkadeIntentsInitOptions): Promise<void> {
    if (this.venue) return;
    if (this._initPromise && this._initGeneration === this._generation) {
      return this._initPromise;
    }
    const generation = this._generation;
    this._initGeneration = generation;
    const promise = this._doInitialize(wallet, options, generation);
    this._initPromise = promise;
    promise.finally(() => {
      if (this._initPromise === promise && this._initGeneration === generation) {
        this._initPromise = null;
      }
    });
    return promise;
  }

  private async _doInitialize(
    wallet: IWallet,
    options: ArkadeIntentsInitOptions,
    generation: number,
  ): Promise<void> {
    try {
      const mod = await loadWdkModule(VENUE_MODULE, () => {
        // Non-literal on purpose — see the module doc. Hosts register a
        // loader; this fallback covers node/Vite where the subpath resolves.
        const specifier = VENUE_MODULE;
        return import(/* @vite-ignore */ specifier);
      });
      const venue = new mod.ArkadeIntentsVenue({
        wallet,
        arkServerUrl: options.arkServerUrl,
        transport: options.transport,
        store: options.store ?? ArkadeIntentsStore.fromPlatform(),
        assetSwapRepository: options.assetSwapRepository,
      }) as ArkadeIntentsVenueLike;
      if (generation !== this._generation) {
        log.info("[ArkadeIntentsClientManager] Stale init discarded");
        this.closeTransport(options.transport);
        return;
      }
      this.venue = venue;
      this.transport = options.transport;
      log.info("[ArkadeIntentsClientManager] Initialized");
    } catch (error) {
      if (generation === this._generation) this.venue = null;
      log.warn("[ArkadeIntentsClientManager] Initialization failed:", error);
      throw error;
    }
  }

  isInitialized(): boolean {
    return this.venue !== null;
  }

  getVenue(): ArkadeIntentsVenueLike {
    if (!this.venue) {
      throw new Error("Arkade Intents venue not initialized. Call initialize() first.");
    }
    return this.venue;
  }

  async dispose(): Promise<void> {
    this._generation += 1;
    if (!this.venue && !this.transport) return;
    // The venue holds no timers or sockets; the transport may (a Nostr
    // relay pool keeps a live subscription). Close is best-effort — the
    // interface doesn't require one.
    this.closeTransport(this.transport);
    this.venue = null;
    this.transport = null;
    log.info("[ArkadeIntentsClientManager] Disposed");
  }

  private closeTransport(transport: unknown): void {
    try {
      (transport as { close?: () => void } | null)?.close?.();
    } catch (error) {
      log.warn("[ArkadeIntentsClientManager] Transport close failed:", error);
    }
  }
}

export const arkadeIntentsClientManager = new ArkadeIntentsClientManager();
