/**
 * Arkade Protocol Adapter
 * Implements IProtocolAdapter using @arkade-os/sdk v0.4.x.
 *
 * Amounts are sats; `wallet.getBalance()` carries `assets: { assetId, amount }[]`
 * and asset metadata resolves via `wallet.assetManager.getAssetDetails(assetId)`.
 */

import { IProtocolAdapter, type ProtocolConfig } from "./IProtocolAdapter";
import { resolveWalletSeed } from "../lib/wallet-seed";
import { HDKey } from "@scure/bip32";
import { signLnMessage, verifyLnMessage } from "../lib/ln-message-sign";
import { log } from "../lib/log";
import {
  getArkadeBalanceCached,
  getArkadeVtxosCached,
  invalidateArkadeSnapshotCache,
} from "../lib/arkade-snapshot-cache";
import { arkadeClientManager } from "../lib/arkade-client-manager";
import { arkadeIntentsClientManager } from "../lib/arkade-intents-client-manager";
import { arkadeSwapsClientManager } from "../lib/arkade-swaps-client-manager";
import {
  Ramps,
  isSpendable,
  type ExtendedVirtualCoin,
  type Wallet,
  type ArkTransaction,
  type ExtendedCoin,
  type Asset as ArkAsset,
} from "@arkade-os/sdk";
import { ArkadeConfig } from "../types/arkade";
import { PROTOCOL_OPERATIONS } from "../capabilities/operations";
import {
  formatSats,
  formatUnits,
  getAssetMetadata,
  getAssetName,
  getAssetPrecision,
  getAssetTicker,
  normalizeVtxos,
  selectVtxosByExpiry,
  sortVtxosByExpiry,
  toNumber,
  toPositiveIntegerBigInt,
  toStringValue,
} from "../lib/arkade-helpers";
import { convertArkTxToUnifiedAll } from "../lib/arkade-converters";
import { applyTransactionFilter } from "../lib/transaction-filter";
import { decodeBolt11Invoice } from "../lib/bolt11";
import {
  ProtocolType,
  Layer,
  NodeInfo,
  UnifiedAsset,
  UnifiedTransaction,
  InvoiceRequest,
  Invoice,
  DecodedInvoice,
  PaymentRequest,
  PaymentResult,
  PaymentStatus,
  Address,
  ConnectionInfo,
  TransactionFilter,
  QuoteRequest,
  Quote,
  SwapResult,
  ProtocolError,
  ConnectionError,
  TransactionStatus,
} from "../types/base";

/** Bare bolt11 prefixes (lnbc / lntb / lnbcrt / lnsb) — case-insensitive. */
function isLightningInvoice(value: string): boolean {
  if (!value) return false;
  const lower = value.trim().toLowerCase();
  // Strip a `lightning:` URI prefix if present.
  const body = lower.startsWith("lightning:") ? lower.slice("lightning:".length) : lower;
  return /^ln(bc|tb|bcrt|sb)/.test(body);
}

function stripLightningPrefix(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("lightning:")
    ? trimmed.slice("lightning:".length)
    : trimmed;
}

function isArkadeAddress(value: string): boolean {
  return /^(ark|tark)1[0-9a-z]{6,}$/i.test(value.trim());
}

export class ArkadeAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = "ARKADE";
  readonly supportedLayers: Layer[] = ["BTC_ARKADE", "BTC_L1", "ARKADE_ARKADE"];
  readonly version = "1.0.0";
  readonly capabilities = PROTOCOL_OPERATIONS.ARKADE;

  private config: ArkadeConfig | null = null;
  private assetDetailsCache = new Map<string, Record<string, unknown> | null>();

  // =========================================================================
  // Connection Management
  // =========================================================================

  async connect(config: ProtocolConfig): Promise<void> {
    const arkadeConfig = config as ArkadeConfig;

    if (!arkadeConfig.mnemonic) {
      throw new ConnectionError("Wallet recovery secret is required for Arkade wallet", "ARKADE");
    }
    if (!arkadeConfig.arkServerUrl) {
      throw new ConnectionError("arkServerUrl is required for Arkade wallet", "ARKADE");
    }

    try {
      await arkadeClientManager.initialize(arkadeConfig);
      this.config = arkadeConfig;
      this.assetDetailsCache.clear();
      log.info("[ArkadeAdapter] Connected to Arkade successfully");

      // Initialize the Boltz swap client in the background. Failures are
      // non-fatal — swaps just stay unavailable until the next connect.
      const wallet = arkadeClientManager.getWallet();
      arkadeSwapsClientManager.initialize(wallet).catch((error: unknown) => {
        log.warn("[ArkadeAdapter] Boltz swaps init failed (Lightning swaps unavailable):", error);
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ConnectionError(`Failed to connect to Arkade: ${msg}`, "ARKADE");
    }
  }

  async disconnect(): Promise<void> {
    // Dispose swap clients first (stops SwapManager monitoring, closes the Intents
    // transport) so neither uses the wallet after teardown. Defensive: Intents is
    // host-initialized, so this no-ops when the host never wired it.
    await arkadeIntentsClientManager.dispose();
    await arkadeSwapsClientManager.dispose();
    await arkadeClientManager.disconnect();
    this.config = null;
    this.assetDetailsCache.clear();
    log.info("[ArkadeAdapter] Disconnected from Arkade");
  }

  isConnected(): boolean {
    return arkadeClientManager.isInitialized();
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }
    return {
      protocol: "ARKADE",
      connected: true,
      network: this.config?.network ?? "signet",
      syncStatus: { synced: true, progress: 100 },
    };
  }

  // =========================================================================
  // Asset Operations
  // =========================================================================

  async listAssets(): Promise<UnifiedAsset[]> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }
    try {
      const wallet = arkadeClientManager.getWallet();
      // Both reads go through the shared snapshot — the summary reuses the
      // same getBalance() RPC instead of issuing a second one.
      const rawBalance = await getArkadeBalanceCached(wallet);
      const balance = await this.getWalletBalanceSummary(wallet);
      const totalSats = balance.total;
      const preconfirmed = balance.preconfirmed;

      const btcAsset: UnifiedAsset = {
        id: "BTC",
        name: "Bitcoin (Arkade)",
        ticker: "BTC",
        precision: 8,
        protocol: "ARKADE",
        layer: "BTC_ARKADE",
        balance: {
          total: totalSats,
          // preconfirmed VTXOs are spendable (isSpendable = !vtxo.isSpent in the SDK),
          // so they count as available just like settled ones.
          available: balance.available,
          pending: 0,
          locked: 0,
          totalDisplay: formatSats(totalSats),
          availableDisplay: formatSats(balance.available),
        },
        capabilities: {
          canSend: true,
          canReceive: true,
          canSwap: false,
          supportsLightning: false,
          supportsOnchain: true,
        },
        metadata: {
          boarding: balance.boardingTotal,
          settled: balance.settled,
          preconfirmed,
          recoverable: balance.recoverable,
        },
      };

      const rawAssets = Array.isArray(rawBalance?.assets) ? rawBalance.assets : [];
      const arkadeAssets = await Promise.all(
        rawAssets
          .filter(
            (entry: ArkAsset) =>
              toStringValue(entry?.assetId) !== "" && toNumber(entry?.amount) > 0,
          )
          .map(async (entry: ArkAsset) => {
            const assetId = toStringValue(entry.assetId);
            const amount = toNumber(entry.amount);
            const details = await this.getCachedAssetDetails(wallet, assetId);
            const metadata = getAssetMetadata(details);
            const precision = getAssetPrecision(metadata);
            const ticker = getAssetTicker(assetId, metadata);
            const name = getAssetName(assetId, ticker, metadata);
            const icon = typeof metadata?.icon === "string" ? metadata.icon : undefined;

            const asset: UnifiedAsset = {
              id: assetId,
              name,
              ticker,
              precision,
              protocol: "ARKADE",
              layer: "ARKADE_ARKADE",
              balance: {
                total: amount,
                available: amount,
                pending: 0,
                locked: 0,
                totalDisplay: formatUnits(amount, precision),
                availableDisplay: formatUnits(amount, precision),
              },
              icon,
              capabilities: {
                canSend: true,
                canReceive: true,
                canSwap: false,
                supportsLightning: false,
                supportsOnchain: false,
              },
              // Don't spread `details` — the Arkade SDK returns BigInt /
              // Uint8Array fields (totalSupply, raw identifiers) that crash
              // chrome.runtime.sendMessage with "Could not serialize message".
              metadata: {
                arkadeAssetId: assetId,
                decimals: precision,
              },
            };

            return asset;
          }),
      );

      return [btcAsset, ...arkadeAssets];
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(`Failed to list assets: ${msg}`, "ARKADE", "LIST_ASSETS_ERROR");
    }
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets();
    const asset = assets.find((a) => a.id === assetId || a.ticker === assetId);
    if (!asset) {
      throw new ProtocolError(`Asset not found: ${assetId}`, "ARKADE", "ASSET_NOT_FOUND");
    }
    return asset;
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset["balance"]> {
    if (assetId === "BTC" || assetId.toLowerCase() === "btc") {
      const asset = await this.getAsset("BTC");
      return asset.balance;
    }

    const asset = await this.getAsset(assetId);
    return asset.balance;
  }

  /** Drop the shared snapshot so the next balance/VTXO read reaches Ark. */
  async refreshBalances(): Promise<void> {
    invalidateArkadeSnapshotCache();
  }

  // =========================================================================
  // Transaction Operations
  // =========================================================================

  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }
    try {
      const wallet = arkadeClientManager.getWallet();
      const history: ArkTransaction[] = await wallet.getTransactionHistory();

      const resolveDetails = (assetId: string) => this.getCachedAssetDetails(wallet, assetId);
      const expanded = await Promise.all(
        (history ?? []).map((item: ArkTransaction) =>
          convertArkTxToUnifiedAll(item, resolveDetails),
        ),
      );
      const validTxs: UnifiedTransaction[] = expanded.flat();

      return applyTransactionFilter(validTxs, filter);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        `Failed to list transactions: ${msg}`,
        "ARKADE",
        "LIST_TRANSACTIONS_ERROR",
      );
    }
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    const txs = await this.listTransactions();
    const tx = txs.find((t) => t.id === txId);
    if (!tx) {
      throw new ProtocolError(`Transaction not found: ${txId}`, "ARKADE", "TX_NOT_FOUND");
    }
    return tx;
  }

  // =========================================================================
  // Payment Operations
  // =========================================================================

  /** Honor an explicit Lightning layer instead of returning an Ark address. */
  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }
    if (request.layer === "BTC_LN") return this.createArkadeLightningInvoice(request);
    try {
      const wallet = arkadeClientManager.getWallet();
      const address: string = await wallet.getAddress();
      return {
        invoice: address,
        paymentHash: "",
        amount: request.amount,
        expiresAt: Date.now() + (request.expirySeconds ?? 3600) * 1000,
        description: request.description ?? "Arkade receiving address",
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(`Failed to create invoice: ${msg}`, "ARKADE", "CREATE_INVOICE_ERROR");
    }
  }

  /**
   * Boltz reverse-swap Lightning invoice that lands the funds here as a VTXO.
   * Requires amount > 0 — Boltz can't issue an amountless invoice. The embedded
   * `SwapManager` claims the VHTLC once the LN payment settles.
   */
  async createArkadeLightningInvoice(request: InvoiceRequest): Promise<Invoice> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }
    if (!request.amount || request.amount <= 0) {
      throw new ProtocolError(
        "Amount is required for Boltz Lightning invoices into Arkade",
        "ARKADE",
        "INVALID_AMOUNT",
      );
    }
    if (!arkadeSwapsClientManager.isInitialized()) {
      throw new ProtocolError(
        "Lightning swaps are not ready yet. Try again in a moment.",
        "ARKADE",
        "SWAPS_NOT_READY",
      );
    }
    try {
      const swaps = arkadeSwapsClientManager.getClient();
      const result = await swaps.createLightningInvoice({
        amount: request.amount,
        description: request.description,
      });
      return {
        invoice: result.invoice,
        paymentHash: result.paymentHash ?? "",
        amount: request.amount,
        expiresAt: Date.now() + (request.expirySeconds ?? 3600) * 1000,
        description: request.description ?? "Boltz reverse swap into Arkade",
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        `Failed to create Boltz Lightning invoice: ${msg}`,
        "ARKADE",
        "CREATE_INVOICE_ERROR",
      );
    }
  }

  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    const destination = invoice.trim();
    if (isArkadeAddress(destination)) {
      return { paymentHash: "", expiresAt: 0, destination };
    }
    if (isLightningInvoice(destination)) {
      try {
        const decoded = decodeBolt11Invoice(stripLightningPrefix(destination));
        return {
          paymentHash: decoded.paymentHash,
          amount: decoded.amountSat == null ? undefined : Number(decoded.amountSat),
          amountMsat: decoded.amountMsat == null ? undefined : Number(decoded.amountMsat),
          expiresAt: decoded.expiresAtUnixSeconds * 1000,
          destination,
        };
      } catch (error: unknown) {
        throw new ProtocolError(
          "Invalid Arkade Lightning invoice",
          "ARKADE",
          "INVALID_INVOICE",
          error,
        );
      }
    }
    throw new ProtocolError(
      "Input is neither an Arkade address nor a valid Lightning invoice",
      "ARKADE",
      "INVALID_INVOICE",
    );
  }

  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }

    // Lightning invoice → Boltz submarine swap. The swap library takes the amount
    // from the invoice, so amountless invoices cannot be paid this way (Boltz
    // rejects with "0 is less than minimal of 333"). Reject early with a clear
    // error rather than surfacing that.
    if (isLightningInvoice(request.invoice)) {
      if (!arkadeSwapsClientManager.isInitialized()) {
        throw new ProtocolError(
          "Lightning swaps are not ready yet. Try again in a moment.",
          "ARKADE",
          "SWAPS_NOT_READY",
        );
      }
      const invoiceBody = stripLightningPrefix(request.invoice);
      try {
        const swaps = arkadeSwapsClientManager.getClient();
        const result = await swaps.sendLightningPayment({ invoice: invoiceBody });
        // Neither a txid nor a preimage means nothing came back that evidences the
        // payment — that is a send failure, not a pending payment with an empty id.
        if (!result?.txid && !result?.preimage) {
          throw new ProtocolError(
            "Arkade Lightning send returned no transaction id and no preimage",
            "ARKADE",
            "SEND_ERROR",
          );
        }
        return {
          // Keep the settlement secret separate from the public lookup identifier.
          paymentHash: result.txid ?? "",
          preimage: result.preimage,
          amount: result.amount ?? request.amount ?? 0,
          fee: 0,
          // Boltz submarine swap; the swap can still fail in the HODL/claim
          // phase. Caller polls `getPaymentStatus` to reach a terminal state.
          status: "pending" as TransactionStatus,
          timestamp: Date.now(),
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        // Translate Boltz error strings to actionable messages.
        if (/less than minimal/i.test(msg)) {
          throw new ProtocolError(
            "Arkade can't pay amountless Lightning invoices. Please use a different route or ask the recipient for an invoice with an amount.",
            "ARKADE",
            "INVALID_AMOUNT",
          );
        }
        if (/vHTLC.*already exists/i.test(msg)) {
          throw new ProtocolError(
            "A swap for this invoice is already in progress. Wait for it to complete or refund before retrying.",
            "ARKADE",
            "SWAP_IN_PROGRESS",
          );
        }
        throw new ProtocolError(
          `Failed to send Lightning payment via Boltz: ${msg}`,
          "ARKADE",
          "SEND_PAYMENT_ERROR",
        );
      }
    }

    // Non-Lightning destinations: existing Ark / on-chain BTC path.
    if (!request.amount || request.amount <= 0) {
      throw new ProtocolError("Amount is required for Arkade payments", "ARKADE", "INVALID_AMOUNT");
    }
    try {
      const wallet = arkadeClientManager.getWallet();
      const selectedVtxos = await this.selectSpendableBtcVtxos(wallet, request.amount);
      const txid: string = await wallet.sendBitcoin({
        address: request.invoice, // Ark or on-chain address
        amount: request.amount, // satoshis
        ...(selectedVtxos ? { selectedVtxos } : {}),
      });
      invalidateArkadeSnapshotCache();
      return {
        paymentHash: txid,
        amount: request.amount,
        fee: 0,
        // Ark VTXO sends are immediately valid once sendBitcoin resolves.
        // On-chain destinations still need confirmation, so callers should
        // keep polling via getPaymentStatus.
        status: (isArkadeAddress(request.invoice) ? "confirmed" : "pending") as TransactionStatus,
        timestamp: Date.now(),
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(`Failed to send payment: ${msg}`, "ARKADE", "SEND_PAYMENT_ERROR");
    }
  }

  /** Resolve public payment IDs against transaction history. */
  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    // Disconnection is a lookup failure, not evidence that payment is pending.
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }
    if (!paymentHash) {
      return { paymentHash, status: "pending" as TransactionStatus };
    }
    try {
      const wallet = arkadeClientManager.getWallet();
      const history = (await wallet.getTransactionHistory()) as Array<{
        key?: { txid?: string } | string;
        settled?: boolean;
        type?: string;
        amount?: number;
      }>;
      const match = history.find((entry) => {
        const key = entry?.key;
        const id = typeof key === "string" ? key : key?.txid;
        return id === paymentHash;
      });
      if (!match) {
        return { paymentHash, status: "pending" as TransactionStatus };
      }
      // Arkade's reference wallet treats SENT history rows as settled while
      // leaving unsettled RECEIVED rows as preconfirmed/pending.
      const isSent = match.type === "SENT";
      return {
        paymentHash,
        status: (isSent || match.settled ? "confirmed" : "pending") as TransactionStatus,
        amount: match.amount,
        timestamp: Date.now(),
      };
    } catch (error: unknown) {
      log.warn("[ArkadeAdapter] getPaymentStatus history lookup failed:", error);
      return { paymentHash, status: "unknown" as TransactionStatus };
    }
  }

  // =========================================================================
  // Address Operations
  // =========================================================================

  async getReceiveAddress(assetId?: string): Promise<Address> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }
    try {
      const wallet = arkadeClientManager.getWallet();

      // 'onchain' or 'boarding' → return on-chain boarding address
      if (assetId === "onchain" || assetId === "boarding") {
        const address: string = await wallet.getBoardingAddress();
        return { address, format: "BTC_ADDRESS", asset: "BTC" };
      }

      // Default → Ark address (off-chain)
      const address: string = await wallet.getAddress();
      return {
        address,
        format: "ARKADE_ADDRESS",
        asset: assetId && assetId !== "BTC" ? assetId : "BTC",
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        `Failed to get receive address: ${msg}`,
        "ARKADE",
        "GET_ADDRESS_ERROR",
      );
    }
  }

  // =========================================================================
  // Node & Balance Operations
  // =========================================================================

  async getNodeInfo(): Promise<NodeInfo> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }
    try {
      const wallet = arkadeClientManager.getWallet();
      const balance = await this.getWalletBalanceSummary(wallet);
      const spendableSats = balance.available;
      return {
        channelsBalanceMsat: spendableSats * 1000,
        maxPayableMsat: spendableSats * 1000,
        onchainBalanceMsat: balance.boardingConfirmed * 1000,
        pendingOnchainBalanceMsat: balance.boardingUnconfirmed * 1000,
        maxReceivableMsat: 0,
        inboundLiquidityMsats: 0,
        connectedPeers: [],
        utxos: 0,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(`Failed to get node info: ${msg}`, "ARKADE", "NODE_INFO_ERROR");
    }
  }

  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }
    try {
      const wallet = arkadeClientManager.getWallet();
      const balance = await this.getWalletBalanceSummary(wallet);
      // preconfirmed VTXOs are spendable (isSpendable = !vtxo.isSpent in the SDK),
      // so include them in `confirmed` so the Withdraw UI sees the full spendable balance.
      const confirmed = balance.available; // settled + preconfirmed
      const total = balance.total;
      const unconfirmed = Math.max(total - confirmed, 0);
      return { confirmed, unconfirmed, total };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(`Failed to get BTC balance: ${msg}`, "ARKADE", "BALANCE_ERROR");
    }
  }

  async listChannels(): Promise<[]> {
    return [];
  }

  async listPayments(): Promise<{ payments?: unknown[] }> {
    const txs = await this.listTransactions();
    return { payments: txs };
  }

  /**
   * All VTXOs, sorted by batchExpiry ascending, so consumers see soon-to-expire
   * VTXOs first and manual coin selection picks the shortest-lived coins.
   */
  async getVtxos(): Promise<Record<string, unknown>[]> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }
    try {
      const wallet = arkadeClientManager.getWallet();
      const vtxos = await getArkadeVtxosCached(wallet);
      const sorted = sortVtxosByExpiry(vtxos);
      return normalizeVtxos(sorted).map((vtxo) => ({
        txid: vtxo.txid,
        vout: vtxo.vout,
        value: vtxo.value,
        state: vtxo.state,
        batchTxid: vtxo.batchTxid,
        batchExpiry: vtxo.batchExpiry,
        createdAt: vtxo.createdAt,
        assets: vtxo.assets,
      }));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(`Failed to get VTXOs: ${msg}`, "ARKADE", "GET_VTXOS_ERROR");
    }
  }

  async getBoardingUtxos(): Promise<Record<string, unknown>[]> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }
    try {
      const wallet = arkadeClientManager.getWallet();
      const utxos: ExtendedCoin[] = await wallet.getBoardingUtxos();
      return (utxos ?? []).map((u: ExtendedCoin) => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        confirmed: u.status?.confirmed ?? false,
      }));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        `Failed to get boarding UTXOs: ${msg}`,
        "ARKADE",
        "GET_BOARDING_UTXOS_ERROR",
      );
    }
  }

  /**
   * Onboard — settle boarding UTXOs into VTXOs via a Commitment Transaction.
   * Requires a confirmed boarding UTXO; returns the commitment txid.
   */
  async onboard(): Promise<{ txid: string }> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }
    try {
      const wallet = arkadeClientManager.getWallet();
      // Get current fee info from server
      const info = await wallet.arkProvider.getInfo();
      const commitmentTxid: string = await new Ramps(wallet).onboard(info.fees);
      invalidateArkadeSnapshotCache();
      return { txid: commitmentTxid };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(`Onboard failed: ${msg}`, "ARKADE", "ONBOARD_ERROR");
    }
  }

  /**
   * Offboard — collaborative exit: VTXOs back to an on-chain UTXO.
   * @param address  Bitcoin on-chain destination (bc1/tb1)
   * @param amount   Optional sats; undefined = exit all
   */
  async offboard(address: string, amount?: number): Promise<{ txid: string }> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }
    if (!address) {
      throw new ProtocolError(
        "Destination address required for offboard",
        "ARKADE",
        "INVALID_ADDRESS",
      );
    }
    if (amount !== undefined && (!Number.isInteger(amount) || amount <= 0)) {
      throw new ProtocolError(
        `Invalid offboard amount: ${amount} (must be a positive integer of sats)`,
        "ARKADE",
        "INVALID_AMOUNT",
      );
    }
    try {
      const wallet = arkadeClientManager.getWallet();
      const info = await wallet.arkProvider.getInfo();
      const exitTxid: string = await new Ramps(wallet).offboard(
        address,
        info.fees,
        amount !== undefined ? BigInt(amount) : undefined,
      );
      invalidateArkadeSnapshotCache();
      return { txid: exitTxid };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(`Offboard failed: ${msg}`, "ARKADE", "OFFBOARD_ERROR");
    }
  }

  async listTransfers(_options?: { asset_id?: string }): Promise<{ transfers: [] }> {
    return { transfers: [] };
  }

  // =========================================================================
  // Asset / On-chain Send
  // =========================================================================

  async sendAsset(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }

    const request = (params ?? {}) as {
      assetId?: string;
      amount?: number | string | bigint;
      recipientId?: string;
    };

    const assetId = toStringValue(request.assetId);
    const amount = toPositiveIntegerBigInt(request.amount);
    const recipientId = toStringValue(request.recipientId);

    if (!assetId) {
      throw new ProtocolError("Asset ID is required", "ARKADE", "INVALID_ASSET");
    }
    if (!recipientId) {
      throw new ProtocolError("Recipient address is required", "ARKADE", "INVALID_ADDRESS");
    }
    if (amount <= 0n) {
      throw new ProtocolError("Amount must be greater than zero", "ARKADE", "INVALID_AMOUNT");
    }

    try {
      const wallet = arkadeClientManager.getWallet();
      const txid: string = await wallet.send({
        address: recipientId,
        assets: [{ assetId, amount }],
      });
      invalidateArkadeSnapshotCache();
      return { txid };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(`Failed to send Arkade asset: ${msg}`, "ARKADE", "SEND_ASSET_ERROR");
    }
  }

  async sendBtcOnchain(params: {
    address: string;
    amount: number;
  }): Promise<Record<string, unknown>> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "ARKADE", "NOT_CONNECTED");
    }
    try {
      const wallet = arkadeClientManager.getWallet();
      const selectedVtxos = await this.selectSpendableBtcVtxos(wallet, params.amount);
      const txid: string = await wallet.sendBitcoin({
        address: params.address,
        amount: params.amount,
        ...(selectedVtxos ? { selectedVtxos } : {}),
      });
      invalidateArkadeSnapshotCache();
      return { txid };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(`Failed to send BTC: ${msg}`, "ARKADE", "SEND_BTC_ERROR");
    }
  }

  // =========================================================================
  // Swap Operations (Not supported)
  // =========================================================================

  supportsSwaps(): boolean {
    return false;
  }

  async getSwapQuote(_request: QuoteRequest): Promise<Quote> {
    throw new ProtocolError("Not supported", "ARKADE", "NOT_SUPPORTED");
  }

  async executeSwap(_quote: Quote): Promise<SwapResult> {
    throw new ProtocolError("Not supported", "ARKADE", "NOT_SUPPORTED");
  }

  async getSwapStatus(_swapId: string): Promise<SwapResult> {
    throw new ProtocolError("Not supported", "ARKADE", "NOT_SUPPORTED");
  }

  // =========================================================================
  // Message Signing
  // =========================================================================

  async signMessage(message: string): Promise<string> {
    if (!this.config?.mnemonic) {
      throw new ProtocolError("Wallet mnemonic not available", "ARKADE", "NOT_CONNECTED");
    }
    const seed = resolveWalletSeed(this.config.mnemonic);
    const node = HDKey.fromMasterSeed(seed).derive("m/138'/1");
    if (!node.privateKey) {
      throw new ProtocolError(
        "Failed to derive message-signing key",
        "ARKADE",
        "KEY_DERIVATION_ERROR",
      );
    }
    return signLnMessage(message, node.privateKey);
  }

  async verifyMessage(message: string, signature: string): Promise<string> {
    return verifyLnMessage(message, signature);
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  /**
   * Pre-select spendable BTC VTXOs for sendBitcoin using the expiry-first policy.
   * Returns `undefined` (not `[]`) when no override applies, letting the SDK fall
   * back to its own selection. Mixed-asset VTXOs are filtered out.
   */
  private async selectSpendableBtcVtxos(
    wallet: Wallet,
    targetSats: number,
  ): Promise<ExtendedVirtualCoin[] | undefined> {
    if (!Number.isFinite(targetSats) || targetSats <= 0) return undefined;
    try {
      // Deliberately NOT the snapshot cache: coin selection from a stale
      // VTXO list could double-select a just-spent VTXO. Always fresh here.
      const raw = await wallet.getVtxos();
      const list: ExtendedVirtualCoin[] = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { vtxos?: unknown[] } | null | undefined)?.vtxos)
          ? (raw as { vtxos: ExtendedVirtualCoin[] }).vtxos
          : [];
      const spendableBtc = list.filter((vtxo) => {
        if (!isSpendable(vtxo)) return false;
        // Exclude VTXOs carrying assets — sendBitcoin would either reject
        // them or accidentally burn the asset side. Pure BTC only.
        const assets = (vtxo as unknown as { assets?: unknown[] }).assets;
        if (Array.isArray(assets) && assets.length > 0) return false;
        return true;
      });
      const selected = selectVtxosByExpiry(spendableBtc, targetSats);
      return selected ?? undefined;
    } catch (error) {
      log.warn(
        "[ArkadeAdapter] selectSpendableBtcVtxos failed; falling back to SDK default selection:",
        error,
      );
      return undefined;
    }
  }

  private async getWalletBalanceSummary(wallet: Wallet): Promise<{
    boardingConfirmed: number;
    boardingUnconfirmed: number;
    boardingTotal: number;
    settled: number;
    preconfirmed: number;
    available: number;
    recoverable: number;
    total: number;
  }> {
    const balance = await getArkadeBalanceCached(wallet);
    const normalized = {
      boardingConfirmed: toNumber(balance?.boarding?.confirmed),
      boardingUnconfirmed: toNumber(balance?.boarding?.unconfirmed),
      boardingTotal: toNumber(balance?.boarding?.total),
      settled: toNumber(balance?.settled),
      preconfirmed: toNumber(balance?.preconfirmed),
      available: toNumber(balance?.available),
      recoverable: toNumber(balance?.recoverable),
      total: toNumber(balance?.total),
    };

    let normalizedVtxos: ReturnType<typeof normalizeVtxos> = [];
    try {
      normalizedVtxos = normalizeVtxos(await getArkadeVtxosCached(wallet));
    } catch (error) {
      log.warn(
        "[ArkadeAdapter] Failed to derive balance from VTXOs, falling back to wallet.getBalance()",
        error,
      );
    }
    if (normalizedVtxos.length === 0) {
      // Mirror the vtxo path: boarding UTXOs must be counted in total even
      // when there are no VTXOs. The SDK's top-level balance.total omits the
      // boarding portion, so we compute it the same way as the vtxo path below.
      const available = normalized.settled + normalized.preconfirmed;
      return {
        ...normalized,
        available,
        total: normalized.boardingTotal + available + normalized.recoverable,
      };
    }

    const vtxoSummary = normalizedVtxos.reduce(
      (summary, vtxo) => {
        if (vtxo.state === "swept") {
          summary.recoverable += vtxo.value;
        } else if (vtxo.state === "preconfirmed") {
          summary.preconfirmed += vtxo.value;
        } else {
          summary.settled += vtxo.value;
        }

        return summary;
      },
      {
        settled: 0,
        preconfirmed: 0,
        recoverable: 0,
      },
    );

    const available = vtxoSummary.settled + vtxoSummary.preconfirmed;
    const total = normalized.boardingTotal + available + vtxoSummary.recoverable;

    return {
      ...normalized,
      settled: vtxoSummary.settled,
      preconfirmed: vtxoSummary.preconfirmed,
      available,
      recoverable: vtxoSummary.recoverable,
      total,
    };
  }

  private async getCachedAssetDetails(
    wallet: Wallet,
    assetId: string,
  ): Promise<Record<string, unknown> | null> {
    if (this.assetDetailsCache.has(assetId)) {
      return this.assetDetailsCache.get(assetId) ?? null;
    }

    try {
      const details = await wallet.assetManager.getAssetDetails(assetId);
      const normalized =
        details && typeof details === "object" ? (details as Record<string, unknown>) : null;
      this.assetDetailsCache.set(assetId, normalized);
      return normalized;
    } catch (error) {
      log.warn("[ArkadeAdapter] Failed to fetch asset details for", assetId, error);
      this.assetDetailsCache.set(assetId, null);
      return null;
    }
  }
}
