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
import { WalletSessionGuard, type SessionAttempt } from "./wallet-session";

type SwapsClient = InstanceType<typeof ArkadeSwaps>;

/** Default IndexedDB database name for swap persistence. */
const DEFAULT_DB_NAME = "kaleidoswap-arkade-swaps";

export interface ArkadeSwapsInitOptions {
  dbName?: string;
  /** Platform-supplied swap repository (required off-browser, e.g. React Native). */
  swapRepository?: unknown;
}

/** The guard's single slot: the Boltz swaps-client handshake. */
const CLIENT_SLOT = "client";

class ArkadeSwapsClientManager {
  private client: SwapsClient | null = null;
  /**
   * The wallet `client` was built for. A swaps client signs with the wallet it
   * was created from, so serving it to a different wallet's session spends the
   * previous wallet's VTXOs. Kept so `initialize()` can tell a genuine re-init
   * from a wallet switch.
   */
  private clientWallet: IWallet | null = null;
  /**
   * Wallet identity + generation guard, shared with the other client managers.
   * The wallet key is the `IWallet` instance itself, recorded from the moment
   * the attempt starts — which is what stops an in-flight `ArkadeSwaps.create()`
   * for wallet A being handed to wallet B's caller while `this.client` is still
   * null (finding N1). See src/lib/wallet-session.ts.
   */
  private readonly session = new WalletSessionGuard({ name: "ArkadeSwapsClientManager" });

  /**
   * Initialize the swaps client with a connected Arkade wallet.
   * Concurrent calls for the SAME wallet share the in-flight handshake. A call
   * for a different wallet, or one arriving after a dispose(), supersedes the
   * pending attempt and builds its own — the superseded client is disposed.
   */
  initialize(wallet: IWallet, opts?: ArkadeSwapsInitOptions): Promise<void> {
    // Same wallet, client already built → nothing to do.
    if (this.client && this.clientWallet === wallet) return Promise.resolve();
    // A client bound to a DIFFERENT wallet must not be reused: `ProtocolManager
    // .connect()` re-connects an adapter without calling `disconnect()` first, so
    // a wallet switch reaches here with a live client still holding the previous
    // wallet's keys. Tear it down and build one for the wallet we were given.
    if (this.client) {
      const stale = this.client;
      this.client = null;
      this.clientWallet = null;
      this.session.invalidate();
      void Promise.resolve()
        .then(() => stale.dispose())
        .catch((error: unknown) =>
          log.warn('[ArkadeSwapsClientManager] Error disposing superseded client:', error),
        );
    }
    // The in-flight case — the seam the teardown branch above cannot cover,
    // because it only fires once a client EXISTS. While ArkadeSwaps.create() is
    // pending `this.client` is null, so a wallet switch that races it would
    // otherwise return wallet A's promise to wallet B's caller, and A's client
    // would install and sign with A's keys for the rest of B's session
    // (finding N1). The guard keys the in-flight slot on the wallet itself, so
    // B's caller supersedes A's attempt and gets its own. ArkadeAdapter.connect()
    // does not await this init, so the window is the normal case, not an edge one.
    return this.session.begin(CLIENT_SLOT, wallet, (attempt) =>
      this._doInitialize(wallet, attempt, opts),
    );
  }

  private async _doInitialize(
    wallet: IWallet,
    attempt: SessionAttempt,
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
      // Guard: dispose(), or a wallet switch, may have landed while
      // ArkadeSwaps.create was awaited. If so this client is stale — discard it.
      if (!(await attempt.claim(() => client.dispose()))) return;
      this.client = client;
      this.clientWallet = wallet;
      log.info("[ArkadeSwapsClientManager] Initialized (Boltz swaps ready)");
    } catch (error: unknown) {
      // Only clear client if this init still owns the session (prevents a stale
      // failed init from clearing a newer successful client).
      if (attempt.isCurrent) {
        this.client = null;
        this.clientWallet = null;
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
    // Invalidate first so any in-flight _doInitialize sees the change even if
    // ArkadeSwaps.create() has not returned yet.
    this.session.invalidate();
    this.clientWallet = null;
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
