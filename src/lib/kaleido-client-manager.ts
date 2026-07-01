/**
 * KaleidoClient Manager
 * Singleton manager for KaleidoClient lifecycle (RGB Lightning node + Kaleidoswap maker).
 *
 * Transport is either "http" (kaleido-sdk's HTTP RlnClient) or "nwc" (an
 * RLN-shaped client over Nostr Wallet Connect). The NWC implementation carries
 * a nostr/relay dependency, so it is NOT bundled here — the consumer injects a
 * factory via `setNwcRlnClientFactory()` (the extension supplies its NwcRlnClient;
 * React Native / node hosts that don't use NWC never register one).
 */

import { KaleidoClient } from "kaleido-sdk";
import type { MakerClient } from "kaleido-sdk";
import { log } from "./log";
import { ProtocolError } from "../types/base";
import type { RgbTransport } from "../types/rgb";

export interface KaleidoClientConfig {
  baseUrl: string;
  nodeUrl?: string;
  apiKey?: string;
  timeout?: number;
  /** Node transport. Defaults to "http". */
  transport?: RgbTransport;
  /** `nostr+walletconnect://` connection string — required when transport === "nwc". */
  nwcUri?: string;
}

/** RLN-shaped client the NWC transport must provide (mirrors kaleido-sdk's RlnClient). */
export interface NwcRlnClientLike {
  close(): void;
  [method: string]: unknown;
}

/** Consumer-injected factory that builds an NWC-backed RLN client from a connection string. */
export type NwcRlnClientFactory = (nwcUri: string) => NwcRlnClientLike;

let nwcRlnClientFactory: NwcRlnClientFactory | null = null;

/**
 * Register the NWC-backed RLN client factory. The extension calls this once at
 * startup with `(uri) => new NwcRlnClient(uri)`. Without it, transport "nwc" throws.
 */
export function setNwcRlnClientFactory(factory: NwcRlnClientFactory): void {
  nwcRlnClientFactory = factory;
}

/**
 * A MakerClient stand-in used in NWC mode when no maker URL is configured.
 * Every access rejects with MAKER_NOT_CONFIGURED so swap flows fail loudly
 * instead of silently hitting the wrong endpoint.
 */
function createMakerStub(): MakerClient {
  return new Proxy(
    {},
    {
      get() {
        return () =>
          Promise.reject(
            new ProtocolError(
              "Maker API not configured. Set a maker URL to enable swaps.",
              "RGB_LN",
              "MAKER_NOT_CONFIGURED",
            ),
          );
      },
    },
  ) as unknown as MakerClient;
}

class KaleidoClientManager {
  private client: KaleidoClient | null = null;
  private config: KaleidoClientConfig | null = null;
  /** Held only in NWC mode so reset() can tear down the relay pool. */
  private nwcRln: NwcRlnClientLike | null = null;

  /** Initialize the KaleidoClient with configuration. */
  initialize(config: KaleidoClientConfig): void {
    // Tear down any prior NWC relay pool before replacing the client.
    this.nwcRln?.close();
    this.nwcRln = null;
    this.config = config;

    if (config.transport === "nwc") {
      if (!config.nwcUri) {
        throw new ProtocolError(
          "NWC connection string is required for transport 'nwc'",
          "RGB_LN",
          "NODE_NOT_CONFIGURED",
        );
      }
      if (!nwcRlnClientFactory) {
        throw new ProtocolError(
          "NWC transport is not available: no NwcRlnClient factory registered. Call setNwcRlnClientFactory() at startup.",
          "RGB_LN",
          "NODE_NOT_CONFIGURED",
        );
      }
      // Compose a KaleidoClient-shaped object: NWC-backed `.rln`, plus an
      // optional HTTP `.maker` (a separate, transport-independent concern).
      const rln = nwcRlnClientFactory(config.nwcUri);
      this.nwcRln = rln;
      const hasMaker = !!config.baseUrl;
      const maker = hasMaker
        ? KaleidoClient.create({ baseUrl: config.baseUrl, timeout: config.timeout }).maker
        : createMakerStub();
      this.client = {
        rln,
        maker,
        hasNode: () => true,
        hasMaker: () => hasMaker,
        close: async () => rln.close(),
      } as unknown as KaleidoClient;

      log.info("[KaleidoClientManager] Initialized NWC transport:", { hasMakerUrl: hasMaker });
      return;
    }

    this.client = KaleidoClient.create({
      baseUrl: config.baseUrl,
      nodeUrl: config.nodeUrl,
      apiKey: config.apiKey,
      timeout: config.timeout,
    });

    log.info("[KaleidoClientManager] Initialized with config:", {
      baseUrl: config.baseUrl,
      hasNodeUrl: !!config.nodeUrl,
      hasApiKey: !!config.apiKey,
    });
  }

  /** @throws if not initialized */
  getClient(): KaleidoClient {
    if (!this.client) {
      throw new Error("KaleidoClient not initialized. Call initialize() first.");
    }
    return this.client;
  }

  isInitialized(): boolean {
    return this.client !== null;
  }

  /**
   * Check if a node is reachable — either an HTTP node URL or an NWC link.
   * Gates almost every RLN operation in the adapter.
   */
  hasNode(): boolean {
    return !!this.config?.nodeUrl || this.config?.transport === "nwc";
  }

  getConfig(): KaleidoClientConfig | null {
    return this.config;
  }

  /**
   * Reset the client (disconnect and clear). Tears down the NWC relay pool
   * when running the NWC transport so we don't leak sockets on reconnect.
   */
  reset(): void {
    this.nwcRln?.close();
    this.nwcRln = null;
    this.client = null;
    this.config = null;
    log.info("[KaleidoClientManager] Reset complete");
  }

  /** Update configuration (re-initializes the client). */
  updateConfig(config: Partial<KaleidoClientConfig>): void {
    if (!this.config) {
      throw new Error("Cannot update config: client not initialized");
    }
    this.initialize({ ...this.config, ...config });
  }
}

export const kaleidoClientManager = new KaleidoClientManager();
