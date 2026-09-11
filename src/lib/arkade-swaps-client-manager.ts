/** Wallet-bound Boltz swaps client with injectable persistence. */

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
  /** Wallet whose signing capability the current client holds. */
  private clientWallet: IWallet | null = null;
  /** Guard in-flight construction by wallet identity and generation. */
  private readonly session = new WalletSessionGuard({ name: "ArkadeSwapsClientManager" });

  /** Share same-wallet initialization; supersede and dispose stale attempts. */
  initialize(wallet: IWallet, opts?: ArkadeSwapsInitOptions): Promise<void> {
    if (this.client && this.clientWallet === wallet) return Promise.resolve();
    // A fund-moving client must never cross wallet identities.
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
   * Stop the embedded SwapManager and release resources. Safe when never
   * initialized.
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
