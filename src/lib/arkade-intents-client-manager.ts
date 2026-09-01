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
import { WalletSessionGuard, type SessionAttempt } from "./wallet-session";

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

/** The guard's single slot: the wallet-bound venue handshake. */
const VENUE_SLOT = "venue";

class ArkadeIntentsClientManager {
  private venue: ArkadeIntentsVenueLike | null = null;
  /** The wallet whose signing capability the live venue holds. */
  private venueWallet: IWallet | null = null;
  private transport: unknown = null;
  /**
   * Records wallet identity before the async module load starts. A venue can
   * fund, claim and refund with its `IWallet`, so sharing wallet A's pending
   * load with wallet B would put B's session on A's keys.
   */
  private readonly session = new WalletSessionGuard({ name: "ArkadeIntentsClientManager" });

  /**
   * Initialize the venue with a connected Arkade wallet. Concurrent calls of the
   * same generation share the in-flight promise; a dispose() bumps the generation so
   * a stale init is discarded.
   */
  async initialize(wallet: IWallet, options: ArkadeIntentsInitOptions): Promise<void> {
    if (this.venue && this.venueWallet === wallet) return;
    if (this.venue) {
      this.releaseVenue(this.venue);
    }
    return this.session.begin(VENUE_SLOT, wallet, (attempt) =>
      this._doInitialize(wallet, options, attempt),
    );
  }

  private async _doInitialize(
    wallet: IWallet,
    options: ArkadeIntentsInitOptions,
    attempt: SessionAttempt,
  ): Promise<void> {
    attempt.mark();
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
      if (!(await attempt.claim(() => this.closeTransport(options.transport)))) return;
      this.venue = venue;
      this.venueWallet = wallet;
      this.transport = options.transport;
      log.info("[ArkadeIntentsClientManager] Initialized");
    } catch (error) {
      if (attempt.isCurrent) {
        this.venue = null;
        this.venueWallet = null;
        this.transport = null;
      }
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
    this.session.invalidate();
    if (!this.venue && !this.transport) return;
    // The venue holds no timers or sockets; the transport may (a Nostr
    // relay pool keeps a live subscription). Close is best-effort — the
    // interface doesn't require one.
    this.closeTransport(this.transport);
    this.venue = null;
    this.venueWallet = null;
    this.transport = null;
    log.info("[ArkadeIntentsClientManager] Disposed");
  }

  /** Release only the venue instance observed by the wallet-switch caller. */
  private releaseVenue(expected: ArkadeIntentsVenueLike): void {
    if (!this.session.releaseIf(this.venue, expected)) return;
    this.closeTransport(this.transport);
    this.venue = null;
    this.venueWallet = null;
    this.transport = null;
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
