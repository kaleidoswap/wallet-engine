/** Arkade wallet lifecycle with injected platform providers. */

import type { ArkadeConfig } from "../types/arkade";
import { WalletSessionGuard, type SessionAttempt } from "./wallet-session";
import { DEFAULT_VTXO_THRESHOLD_SECONDS } from "./arkade-vtxo-lifecycle";
import { log } from "./log";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import { bech32 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  Wallet,
  SingleKey,
  MnemonicIdentity,
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
 * Platform providers injected by consumers. Absent a factory the manager falls
 * back to the SDK's browser-native implementation (IndexedDB,
 * `RestDelegatorProvider`); non-browser hosts must inject what they rely on.
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
 * needs: `nsec1…`, 64-char hex, or BIP39 mnemonic (BIP86
 * `m/86'/{coinType}'/0'/0/0`).
 */
export function resolveArkadePrivateKeyHex(walletSecret: string, isMainnet: boolean): string {
  const trimmed = walletSecret.trim();

  if (trimmed.startsWith("nsec1")) {
    const hex = nsecToPrivateKeyHex(trimmed);
    if (hex) return hex;
    // A string claiming to be an nsec but failing checksum/length must NOT
    // fall through to the mnemonic branch — mnemonicToSeedSync PBKDF2s any
    // string, so it would silently derive a valid-but-different empty wallet.
    throw new Error("Invalid wallet secret: nsec1… failed to decode to a 32-byte key");
  }

  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  // Fail loud on an invalid phrase instead of seeding a wrong wallet
  // (mnemonicToSeedSync itself performs no validation).
  if (!validateMnemonic(trimmed, wordlist)) {
    throw new Error("Invalid wallet secret: not an nsec1… key, 64-char hex key, or valid BIP39 mnemonic");
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

/**
 * True when the secret is a BIP39 mnemonic. HD rotation needs a mnemonic-backed
 * `MnemonicIdentity`; nsec/hex secrets stay single-key.
 */
function isBip39Secret(walletSecret: string): boolean {
  const trimmed = walletSecret.trim();
  if (trimmed.startsWith("nsec1")) return false;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return false;
  return trimmed.split(/\s+/).length >= 12;
}

// ---------------------------------------------------------------------------
// ArkadeClientManager
// ---------------------------------------------------------------------------

/** The guard's single slot: the Arkade wallet handshake. */
const WALLET_SLOT = "wallet";

/** Compare every field that identifies an Arkade wallet session. */
function sameArkadeConfig(a: unknown, b: unknown): boolean {
  const x = a as ArkadeConfig | null;
  const y = b as ArkadeConfig | null;
  return (
    x?.network === y?.network &&
    x?.mnemonic === y?.mnemonic &&
    x?.walletMode === y?.walletMode &&
    x?.arkServerUrl === y?.arkServerUrl &&
    x?.delegatorUrl === y?.delegatorUrl &&
    x?.delegationEnabled === y?.delegationEnabled &&
    x?.vtxoThresholdSeconds === y?.vtxoThresholdSeconds
  );
}

class ArkadeClientManager {
  private wallet: Wallet | null = null;
  private _vtxoManager: VtxoManager | null = null;
  private config: ArkadeConfig | null = null;
  /** Reject a wallet switch that races an in-flight handshake. */
  private readonly session = new WalletSessionGuard({
    name: "ArkadeClientManager",
    sameWallet: sameArkadeConfig,
    onConflict: "reject",
    conflictError: () =>
      new Error(
        "Arkade client is already initializing with a different config. Call dispose() first.",
      ),
  });
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
   * Initialize the Arkade wallet. Concurrent calls share the in-flight promise;
   * throws if already initializing with a different identity or network (call
   * dispose() first).
   */
  initialize(config: ArkadeConfig): Promise<void> {
    return this.session.begin(WALLET_SLOT, config, (attempt) =>
      this._doInitialize(config, attempt),
    );
  }

  private async _doInitialize(config: ArkadeConfig, attempt: SessionAttempt): Promise<void> {
    if (this.wallet) {
      log.warn("[ArkadeClientManager] Wallet already initialized, re-initializing...");
      await this.disconnect();
    }

    this.config = config;
    // Marked AFTER the re-init disconnect above, which invalidates the session itself.
    attempt.mark();

    try {
      const isMainnet = config.network === "mainnet";
      // HD mode needs a mnemonic-backed identity so the SDK can walk `…/0/N`.
      // The extension's historical default is a single static key (index 0), so
      // only enable HD when requested AND the secret is a mnemonic.
      const hdMode = config.walletMode === "hd" && isBip39Secret(config.mnemonic);
      const identity = hdMode
        ? MnemonicIdentity.fromMnemonic(config.mnemonic.trim(), { isMainnet })
        : SingleKey.fromHex(resolveArkadePrivateKeyHex(config.mnemonic, isMainnet));
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
      if (hdMode) {
        (walletConfig as WalletConfig & { walletMode?: string }).walletMode = "hd";
      }

      // Wire delegation provider if configured.
      if (config.delegatorUrl && config.delegationEnabled) {
        walletConfig.delegatorProvider = (this.platformProviders.createDelegatorProvider?.(
          config.delegatorUrl,
        ) ?? new RestDelegatorProvider(config.delegatorUrl)) as WalletConfig["delegatorProvider"];
        log.info("[ArkadeClientManager] Delegation provider configured:", config.delegatorUrl);
      }

      const created = await Wallet.create(walletConfig);

      // Never revive a signing wallet after its session was torn down.
      const claimed = await attempt.claim(() =>
        (created as unknown as { dispose?: () => Promise<void> | void })?.dispose?.(),
      );
      if (!claimed) return;

      this.wallet = created;

      // HD balances need a gap scan; failure does not make the wallet unusable.
      if (hdMode) {
        try {
          await (this.wallet as Wallet & { restore?: () => Promise<void> }).restore?.();
          log.info("[ArkadeClientManager] HD restore gap-scan complete");
        } catch (err) {
          log.warn("[ArkadeClientManager] HD restore gap-scan failed (continuing):", err);
        }
      }

      // Reuse the wallet's own VtxoManager: Wallet.create() already made one with
      // this settlementConfig, and a second would duplicate the contract-event
      // subscription and the boarding-UTXO poll loop.
      this._vtxoManager = await this.wallet.getVtxoManager();

      await this.refreshVtxoState();

      log.info(
        "[ArkadeClientManager] Arkade wallet initialized successfully (vtxoThreshold=%ds, mode=%s)",
        vtxoThreshold,
        hdMode ? "hd" : "static",
      );
    } catch (error: unknown) {
      // Only clear the wallet if this init still owns the session; a failure here
      // must not tear down a newer, successful one.
      if (attempt.isCurrent) {
        this.wallet = null;
        this._vtxoManager = null;
      }
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
    // HD and static share the index-0 pubkey but track different address sets, so
    // they must not share an IndexedDB store. Static keeps the legacy name.
    const modeSuffix = config.walletMode === "hd" ? "-hd" : "";
    return `arkade-wallet-${config.network}-${pubKeyHex.slice(0, 16)}${modeSuffix}`;
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

  /** Return the active wallet instance. Throws if not initialized. */
  getWallet(): Wallet {
    if (!this.wallet) {
      throw new Error("Arkade wallet not initialized. Call initialize() first.");
    }
    return this.wallet;
  }

  /** Return the VtxoManager for VTXO lifecycle ops. Throws if not initialized. */
  getVtxoManager(): VtxoManager {
    if (!this._vtxoManager) {
      throw new Error("VtxoManager not initialized. Call initialize() first.");
    }
    return this._vtxoManager;
  }

  isInitialized(): boolean {
    return this.wallet !== null;
  }

  /**
   * Connected config with the mnemonic REDACTED — one careless
   * `log(getConfig())` in a host would otherwise leak the seed.
   */
  getConfig(): ArkadeConfig | null {
    return this.config ? { ...this.config, mnemonic: "" } : null;
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
    this.session.invalidate();
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
    this.session.invalidate();
    log.info("[ArkadeClientManager] Complete reset performed");
  }

  /**
   * Start listening for incoming VTXOs and boarding UTXOs.
   * @param onIncoming  Fired per notification with the raw SDK payload.
   * @returns Stop function (also called on disconnect/reset)
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

    // Claim synchronously so concurrent calls cannot create orphan subscriptions.
    this._listenerStarted = true;
    // Generation binds the listener and its callbacks to this wallet session.
    const generation = this.session.generation;
    const wallet = this.wallet;

    wallet
      .notifyIncomingFunds((notification) => {
        // Never deliver a stale wallet's notification into the next session.
        if (generation !== this.session.generation) return;
        try {
          onIncoming(notification);
        } catch (err) {
          log.error("[ArkadeClientManager] Error in incoming funds callback:", err);
        }
      })
      .then((stop) => {
        if (generation !== this.session.generation) {
          // Stop a late subscription that teardown can no longer reach.
          try {
            stop();
          } catch {
            /* ignore */
          }
          log.info(
            "[ArkadeClientManager] Incoming funds subscription superseded by teardown — stopped",
          );
          return;
        }
        this._stopIncomingFunds = stop;
        log.info("[ArkadeClientManager] Incoming funds listener started");
      })
      .catch((err) => {
        log.error("[ArkadeClientManager] Failed to start incoming funds listener:", err);
        // Release the slot so a retry (or the next wallet) can subscribe.
        if (generation === this.session.generation) this._listenerStarted = false;
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
