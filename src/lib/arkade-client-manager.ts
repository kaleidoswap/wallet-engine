/**
 * Arkade Client Manager
 *
 * Manages the lifecycle of an Arkade wallet (`@arkade-os/sdk` v0.4.x).
 * The SDK is pure TypeScript — no WASM, no dynamic import() restrictions —
 * so it runs directly inside an MV3 service worker.
 *
 * Platform-agnostic: storage repositories and network providers are injected
 * by consumers via `setPlatformProviders()`. The extension supplies the SDK's
 * IndexedDB repositories (the default when a browser host provides none);
 * React Native injects AsyncStorage-backed repositories. No `chrome.*` /
 * platform globals are referenced here.
 *
 * Wallet-secret handling: new wallets use an nsec root secret. A 64-char hex
 * private key and BIP39 mnemonics (BIP86 Taproot derivation) are also accepted
 * so developer/test imports behave predictably. Deriving nsec-rooted keys
 * directly (rather than via BIP39 `mnemonicToSeedSync`) avoids the
 * "Invalid mnemonic" failure mode nsec-rooted wallets otherwise hit.
 */

import type { ArkadeConfig } from "../types/arkade";
import { DEFAULT_VTXO_THRESHOLD_SECONDS } from "./arkade-vtxo-lifecycle";
import { log } from "./log";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { bech32 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  Wallet,
  SingleKey,
  IndexedDBWalletRepository,
  IndexedDBContractRepository,
  VtxoManager,
  RestDelegatorProvider,
} from "@arkade-os/sdk";
import type { IncomingFunds, WalletConfig } from "@arkade-os/sdk";

// ---------------------------------------------------------------------------
// Platform seam
// ---------------------------------------------------------------------------

/**
 * Platform-specific providers injected by consumers. When a factory is absent
 * the manager falls back to the SDK's browser-native implementation
 * (IndexedDB repositories, `RestDelegatorProvider`), which is correct for the
 * extension. Non-browser hosts (React Native) must inject every provider they
 * rely on.
 */
export interface ArkadePlatformProviders {
  createWalletRepository?: (dbName: string) => unknown;
  createContractRepository?: (dbName: string) => unknown;
  createDelegatorProvider?: (url: string) => unknown;
  createArkProvider?: () => unknown;
  createIndexerProvider?: () => unknown;
}

// ---------------------------------------------------------------------------
// Wallet-secret helpers
// ---------------------------------------------------------------------------

/** Decode an `nsec1…` bech32 secret into a 32-byte private key hex, or null. */
function nsecToPrivateKeyHex(input: string): string | null {
  try {
    // nsec is plain bech32 (not bech32m) over the 32-byte secret. Use a
    // generous length limit — the default 90 is enough but we future-proof.
    const decoded = bech32.decode(input as `${string}1${string}`, 1023);
    if (decoded.prefix !== "nsec") return null;
    const data = bech32.fromWords(decoded.words);
    if (data.length !== 32) return null;
    return bytesToHex(Uint8Array.from(data));
  } catch {
    return null;
  }
}

/**
 * Resolve a wallet secret to the 32-byte private key hex the Arkade identity
 * needs. Accepts (in order): an `nsec1…` root secret, a 64-char hex private
 * key, or a BIP39 mnemonic (BIP86 Taproot `m/86'/{coinType}'/0'/0/0`).
 */
function resolveArkadePrivateKeyHex(walletSecret: string, isMainnet: boolean): string {
  const trimmed = walletSecret.trim();

  if (trimmed.startsWith("nsec1")) {
    const hex = nsecToPrivateKeyHex(trimmed);
    if (hex) return hex;
  }

  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const seed = mnemonicToSeedSync(trimmed);
  const root = HDKey.fromMasterSeed(seed);
  const coinType = isMainnet ? 0 : 1;
  const child = root.derive(`m/86'/${coinType}'/0'/0/0`);
  if (!child.privateKey) {
    throw new Error("Failed to derive private key from wallet secret");
  }
  return bytesToHex(child.privateKey);
}

// ---------------------------------------------------------------------------
// ArkadeClientManager
// ---------------------------------------------------------------------------

class ArkadeClientManager {
  private wallet: Wallet | null = null;
  private _vtxoManager: VtxoManager | null = null;
  private config: ArkadeConfig | null = null;
  /** Serializes concurrent initialize() calls */
  private _initPromise: Promise<void> | null = null;
  /** Config for the in-flight _initPromise (used for concurrent-init guard) */
  private _pendingConfig: ArkadeConfig | null = null;
  /** Cleanup function returned by wallet.notifyIncomingFunds() */
  private _stopIncomingFunds: (() => void) | null = null;
  /** Guards against duplicate startIncomingFundsListener() calls */
  private _listenerStarted = false;
  /** Platform-injected providers (repositories, delegator, network) */
  private platformProviders: ArkadePlatformProviders = {};

  /** Inject platform-specific providers before calling initialize(). */
  setPlatformProviders(providers: ArkadePlatformProviders): void {
    this.platformProviders = providers;
  }

  /**
   * Initialize the Arkade wallet.
   * Concurrent calls share the same in-flight promise to prevent races.
   * Throws if called while already initializing with a different identity or
   * network — the caller must call dispose() first.
   */
  initialize(config: ArkadeConfig): Promise<void> {
    if (this._initPromise) {
      if (
        this._pendingConfig?.network !== config.network ||
        this._pendingConfig?.mnemonic !== config.mnemonic ||
        this._pendingConfig?.arkServerUrl !== config.arkServerUrl ||
        this._pendingConfig?.delegatorUrl !== config.delegatorUrl ||
        this._pendingConfig?.delegationEnabled !== config.delegationEnabled ||
        this._pendingConfig?.vtxoThresholdSeconds !== config.vtxoThresholdSeconds
      ) {
        return Promise.reject(
          new Error(
            "Arkade client is already initializing with a different config. Call dispose() first.",
          ),
        );
      }
      return this._initPromise;
    }
    this._pendingConfig = config;
    this._initPromise = this._doInitialize(config).finally(() => {
      this._initPromise = null;
      this._pendingConfig = null;
    });
    return this._initPromise;
  }

  private async _doInitialize(config: ArkadeConfig): Promise<void> {
    if (this.wallet) {
      log.warn("[ArkadeClientManager] Wallet already initialized, re-initializing...");
      await this.disconnect();
    }

    this.config = config;

    try {
      const isMainnet = config.network === "mainnet";
      const privKeyHex = resolveArkadePrivateKeyHex(config.mnemonic, isMainnet);
      const identity = SingleKey.fromHex(privKeyHex);
      const dbName = await this.buildDbName(config, identity);

      const vtxoThreshold = config.vtxoThresholdSeconds ?? DEFAULT_VTXO_THRESHOLD_SECONDS;
      const settlementConfig = {
        vtxoThreshold,
        boardingUtxoSweep: true,
        pollIntervalMs: 60_000,
      };

      const walletConfig: WalletConfig = {
        identity,
        arkServerUrl: config.arkServerUrl,
        esploraUrl: config.esploraUrl,
        storage: {
          walletRepository: (this.platformProviders.createWalletRepository?.(dbName) ??
            new IndexedDBWalletRepository(
              dbName,
            )) as NonNullable<WalletConfig["storage"]>["walletRepository"],
          contractRepository: (this.platformProviders.createContractRepository?.(dbName) ??
            new IndexedDBContractRepository(
              dbName,
            )) as NonNullable<WalletConfig["storage"]>["contractRepository"],
        },
        settlementConfig,
      };

      // Wire delegation provider if configured.
      if (config.delegatorUrl && config.delegationEnabled) {
        walletConfig.delegatorProvider = (this.platformProviders.createDelegatorProvider?.(
          config.delegatorUrl,
        ) ?? new RestDelegatorProvider(config.delegatorUrl)) as WalletConfig["delegatorProvider"];
        log.info("[ArkadeClientManager] Delegation provider configured:", config.delegatorUrl);
      }

      this.wallet = await Wallet.create(walletConfig);

      // Reuse the wallet's own VtxoManager rather than creating a second one.
      // Wallet.create() already initialises an internal VtxoManager with the
      // same settlementConfig; constructing another would register a duplicate
      // contract-event subscription and a second boarding-UTXO poll loop.
      this._vtxoManager = await this.wallet.getVtxoManager();

      await this.refreshVtxoState();

      log.info(
        "[ArkadeClientManager] Arkade wallet initialized successfully (vtxoThreshold=%ds)",
        vtxoThreshold,
      );
    } catch (error: unknown) {
      this.wallet = null;
      this._vtxoManager = null;
      const msg = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`Failed to initialize Arkade wallet: ${msg}`), {
        cause: error,
      });
    }
  }

  private async buildDbName(
    config: ArkadeConfig,
    identity: { xOnlyPublicKey(): Promise<Uint8Array> },
  ): Promise<string> {
    const pubKey = await identity.xOnlyPublicKey();
    const pubKeyHex = bytesToHex(pubKey);
    return `arkade-wallet-${config.network}-${pubKeyHex.slice(0, 16)}`;
  }

  async refreshVtxoState(): Promise<void> {
    if (!this.wallet) {
      return;
    }

    try {
      const contractManager = await this.wallet.getContractManager();
      await contractManager.refreshVtxos();
    } catch (error) {
      log.warn("[ArkadeClientManager] Failed to refresh VTXO state:", error);
    }
  }

  /**
   * Return the active wallet instance.
   * Throws if not initialized.
   */
  getWallet(): Wallet {
    if (!this.wallet) {
      throw new Error("Arkade wallet not initialized. Call initialize() first.");
    }
    return this.wallet;
  }

  /**
   * Return the VtxoManager for VTXO lifecycle operations.
   * Throws if not initialized.
   */
  getVtxoManager(): VtxoManager {
    if (!this._vtxoManager) {
      throw new Error("VtxoManager not initialized. Call initialize() first.");
    }
    return this._vtxoManager;
  }

  isInitialized(): boolean {
    return this.wallet !== null;
  }

  getConfig(): ArkadeConfig | null {
    return this.config;
  }

  async disconnect(): Promise<void> {
    this.stopIncomingFundsListener();
    this._listenerStarted = false;
    if (this._vtxoManager) {
      try {
        await this._vtxoManager.dispose();
      } catch {
        /* ignore */
      }
      this._vtxoManager = null;
    }
    this.wallet = null;
    this.config = null;
    log.info("[ArkadeClientManager] Wallet disconnected");
  }

  reset(): void {
    this.stopIncomingFundsListener();
    this._listenerStarted = false;
    if (this._vtxoManager) {
      try {
        this._vtxoManager.dispose();
      } catch {
        /* ignore */
      }
      this._vtxoManager = null;
    }
    this.wallet = null;
    this.config = null;
    this._initPromise = null;
    log.info("[ArkadeClientManager] Complete reset performed");
  }

  /**
   * Start listening for incoming VTXOs and boarding UTXOs.
   * @param onIncoming  Callback fired per notification; receives the raw SDK payload.
   * @returns Stop function (also called automatically on disconnect/reset)
   */
  startIncomingFundsListener(onIncoming: (notification: IncomingFunds) => void): void {
    if (this._listenerStarted) {
      log.warn(
        "[ArkadeClientManager] Incoming funds listener already started — ignoring duplicate call",
      );
      return;
    }
    if (!this.wallet) {
      log.warn("[ArkadeClientManager] Cannot start listener — wallet not initialized");
      return;
    }
    // Stop any existing subscription first
    this.stopIncomingFundsListener();

    this.wallet
      .notifyIncomingFunds((notification) => {
        try {
          onIncoming(notification);
        } catch (err) {
          log.error("[ArkadeClientManager] Error in incoming funds callback:", err);
        }
      })
      .then((stop) => {
        this._stopIncomingFunds = stop;
        this._listenerStarted = true;
        log.info("[ArkadeClientManager] Incoming funds listener started");
      })
      .catch((err) => {
        log.error("[ArkadeClientManager] Failed to start incoming funds listener:", err);
      });
  }

  stopIncomingFundsListener(): void {
    if (this._stopIncomingFunds) {
      try {
        this._stopIncomingFunds();
      } catch {
        /* ignore */
      }
      this._stopIncomingFunds = null;
      this._listenerStarted = false;
      log.info("[ArkadeClientManager] Incoming funds listener stopped");
    }
  }
}

export const arkadeClientManager = new ArkadeClientManager();
