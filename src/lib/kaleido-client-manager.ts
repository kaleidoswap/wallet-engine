/**
 * KaleidoClient Manager — lifecycle for the RGB Lightning node + Kaleidoswap maker.
 *
 * Transport is "http" (kaleido-sdk's RlnClient) or "nwc" (RLN-shaped over Nostr
 * Wallet Connect). The NWC implementation carries a nostr/relay dependency, so it
 * is not bundled: consumers inject a factory via `setNwcRlnClientFactory()`.
 */

import { HttpClient, KaleidoClient } from "kaleido-sdk";
import type { MakerClient } from "kaleido-sdk";
import { RlnClient } from "kaleido-sdk/rln";
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

/**
 * Narrow construction seam for direct RLN consumers. The node bearer is named
 * `nodeApiKey`; this type has no maker `apiKey` field.
 */
export interface KaleidoNodeClientConfig {
  baseUrl?: string;
  nodeUrl?: string;
  nodeApiKey?: string;
  timeout?: number;
  logLevel?: "silent";
}

export function createKaleidoClientWithNodeCredential(
  config: KaleidoNodeClientConfig,
): KaleidoClient {
  return KaleidoClient.create({
    ...(config.baseUrl != null ? { baseUrl: config.baseUrl } : {}),
    nodeUrl: config.nodeUrl,
    nodeApiKey: config.nodeApiKey,
    timeout: config.timeout,
    ...(config.logLevel != null ? { logLevel: config.logLevel } : {}),
  });
}

export interface DirectRlnNodeClientConfig {
  nodeUrl: string;
  nodeApiKey?: string;
  /** Matches KaleidoConfig timeout units. */
  timeoutSeconds?: number;
}

export interface DirectRlnNodeClientOwner {
  rln: RlnClient;
  close(): Promise<void>;
}

/** Build an RLN-only SDK client without constructing the default maker client. */
export function createDirectRlnNodeClient(
  config: DirectRlnNodeClientConfig,
): DirectRlnNodeClientOwner {
  const http = new HttpClient({
    nodeUrl: config.nodeUrl,
    nodeApiKey: config.nodeApiKey,
    timeout: config.timeoutSeconds == null ? undefined : config.timeoutSeconds * 1000,
  });
  return {
    // RlnClient's 0.1.17 default LogState is SILENT. Do not accept an
    // application logger here: that SDK version logs full invoices at INFO.
    rln: new RlnClient(http),
    close: () => http.close(),
  };
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
 * Register the NWC-backed RLN client factory, e.g. `(uri) => new NwcRlnClient(uri)`.
 * Without it, transport "nwc" throws.
 */
export function setNwcRlnClientFactory(factory: NwcRlnClientFactory): void {
  nwcRlnClientFactory = factory;
}

/**
 * MakerClient stand-in for NWC mode with no maker URL. Every access rejects with
 * MAKER_NOT_CONFIGURED so swap flows fail loudly rather than hit the wrong endpoint.
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
  // No wallet-derived identity is held here: these are host-supplied node/maker
  // transports, constructed synchronously and replaced before initialize returns.
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

    // `apiKey` here is the RLN node credential (the maker API is public), so it
    // maps to the SDK's node-scoped `nodeApiKey`; passing it as `apiKey` would
    // send it to the maker and never to the node.
    //
    // SECURITY: `nodeApiKey` only exists in kaleido-sdk >= 0.1.16. Do NOT
    // reintroduce a cast here — an unknown extra property is dropped silently, so
    // on an older SDK the node credential would vanish and every RLN call would go
    // out unauthenticated while this method still reported a healthy client.
    // Typed literally, that downgrade is a compile error instead; see
    // `sdkSupportsNodeAuth` in `test/kaleido-node-auth.test.ts`.
    this.client = createKaleidoClientWithNodeCredential({
      baseUrl: config.baseUrl,
      nodeUrl: config.nodeUrl,
      nodeApiKey: config.apiKey,
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
   * Whether a node is reachable (HTTP URL or NWC link). Gates almost every RLN
   * operation in the adapter.
   */
  hasNode(): boolean {
    return !!this.config?.nodeUrl || this.config?.transport === "nwc";
  }

  getConfig(): KaleidoClientConfig | null {
    if (!this.config) return null;
    // NWC URIs embed a client secret and API keys are bearer credentials.
    // Match the Spark/Arkade managers: expose operational settings without
    // making a routine config read or log capable of leaking credentials.
    return {
      ...this.config,
      apiKey: undefined,
      nwcUri: undefined,
    };
  }

  /**
   * Reset the client. Tears down the NWC relay pool under the NWC transport so
   * sockets don't leak on reconnect.
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
