/**
 * RGB Protocol Adapter
 * Uses Kaleido SDK to implement the protocol adapter interface
 */

import { IProtocolAdapter, type ProtocolConfig } from "./IProtocolAdapter";
import { log } from "../lib/log";
import { kaleidoClientManager } from "../lib/kaleido-client-manager";
import type {
  CreateSwapOrderRequest,
  CreateSwapOrderResponse,
  SwapOrderStatusResponse,
} from "kaleido-sdk";
import {
  KaleidoError,
  APIError,
  NetworkError,
  NodeNotConfiguredError,
  QuoteExpiredError,
  InsufficientBalanceError as SdkInsufficientBalanceError,
  Layer as SdkLayer,
} from "kaleido-sdk";
import type {
  CreateLNInvoiceResponse,
  DecodeLNInvoiceResponse,
  KeysendResponse,
  LNInvoiceRequest,
  SendPaymentResponse,
  ListTransfersResponse,
} from "kaleido-sdk/rln";
import {
  ProtocolType,
  Layer,
  NodeInfo,
  UnifiedAsset,
  UnifiedTransaction,
  InvoiceRequest,
  Invoice,
  DecodedInvoice,
  KeysendRequest,
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
  InsufficientBalanceError,
} from "../types/base";
import { RgbConfig } from "../types/rgb";
import { PROTOCOL_OPERATIONS } from "../capabilities/operations";
import { resolveRgbFeeRatePolicy, type FeeUrgency } from "../lib/rgb-fee-policy";
import { mapPaymentStatus, mapSwapStatus } from "../lib/rgb-helpers";
import {
  convertBtcBalance,
  convertNodeAssetToUnified,
  convertPaymentToTransaction,
  convertSdkBalance,
  convertSwapToTransaction,
  convertTransferToTransaction,
} from "../lib/rgb-converters";

/**
 * RGB Protocol Adapter Implementation using Kaleido SDK
 */
export class RgbAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = "RGB_LN";
  readonly supportedLayers: Layer[] = ["RGB_L1", "RGB_LN", "BTC_L1", "BTC_LN"];
  readonly version = "1.0.0";
  readonly capabilities = PROTOCOL_OPERATIONS.RGB_LN;

  private connected = false;
  private config: RgbConfig | null = null;
  private swapAccessTokens = new Map<string, string>();

  // ========================================================================
  // Connection Management
  // ========================================================================

  async connect(config: ProtocolConfig): Promise<void> {
    const rgbConfig = config as RgbConfig;
    const transport = rgbConfig.transport ?? "http";

    // For HTTP a node URL is required; for NWC the connection string is. Maker
    // is optional in both cases.
    if (transport === "nwc") {
      if (!rgbConfig.nwcUri) {
        throw new ConnectionError("NWC connection string is required", "RGB_LN");
      }
    } else if (!rgbConfig.nodeUrl) {
      throw new ConnectionError("Node URL is required", "RGB_LN");
    }

    log.info(
      `[RgbAdapter] connect() — transport=${transport} ${
        transport === "nwc" ? "nwc=(string)" : `nodeUrl=${rgbConfig.nodeUrl}`
      } makerUrl=${rgbConfig.makerUrl || "(none)"} hasApiKey=${!!rgbConfig.apiKey}`,
    );

    try {
      // Initialize Kaleido SDK client (maker URL is optional, transport-independent)
      kaleidoClientManager.initialize({
        baseUrl: rgbConfig.makerUrl || "",
        nodeUrl: rgbConfig.nodeUrl,
        apiKey: rgbConfig.apiKey,
        transport,
        nwcUri: rgbConfig.nwcUri,
      });

      const client = kaleidoClientManager.getClient();

      log.info(`[RgbAdapter] Calling client.rln.getNodeInfo() → ${rgbConfig.nodeUrl}`);
      const t0 = Date.now();
      let nodeInfo: unknown;
      try {
        nodeInfo = await client.rln.getNodeInfo();
        log.info(`[RgbAdapter] getNodeInfo() OK in ${Date.now() - t0}ms:`, nodeInfo);
      } catch (httpErr: unknown) {
        const msg = httpErr instanceof Error ? httpErr.message : String(httpErr);
        log.error(`[RgbAdapter] getNodeInfo() FAILED after ${Date.now() - t0}ms: ${msg}`, httpErr);
        throw httpErr;
      }

      this.config = rgbConfig;
      this.connected = true;

      log.info("[RgbAdapter] Connected to RGB node successfully via SDK");

      // Optionally test maker connection (non-blocking)
      if (rgbConfig.makerUrl) {
        try {
          log.info(`[RgbAdapter] Testing maker API → ${rgbConfig.makerUrl}`);
          await client.maker.listAssets();
          log.info("[RgbAdapter] Maker API accessible ✓");
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          log.warn("[RgbAdapter] Maker API not accessible (swaps will show error):", msg);
          // Don't throw - maker is optional, only needed for swaps
        }
      } else {
        log.info("[RgbAdapter] No maker URL provided (swaps disabled)");
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`[RgbAdapter] connect() failed: ${msg}`);
      throw new ConnectionError(
        `Failed to connect to RGB node: ${msg}`,
        "RGB_LN",
        error instanceof Error ? error : undefined,
      );
    }
  }

  async disconnect(): Promise<void> {
    kaleidoClientManager.reset();
    this.connected = false;
    this.config = null;
    log.info("[RgbAdapter] Disconnected");
  }

  isConnected(): boolean {
    return this.connected && kaleidoClientManager.isInitialized();
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "RGB_LN", "NOT_CONNECTED");
    }

    const info: ConnectionInfo = {
      protocol: "RGB_LN",
      connected: true,
      network: this.config?.network || "regtest",
    };

    // Try to get node info if node is configured
    if (kaleidoClientManager.hasNode()) {
      try {
        const client = kaleidoClientManager.getClient();
        const nodeInfo = await client.rln.getNodeInfo();
        const networkInfo = await client.rln.getNetworkInfo();
        info.nodeId = nodeInfo.pubkey || "";
        info.blockHeight = networkInfo.height || 0;
        info.syncStatus = {
          synced: true,
          progress: 100,
        };
      } catch (error) {
        log.warn("[RgbAdapter] Could not get node info:", error);
      }
    }

    return info;
  }

  // ========================================================================
  // Asset Operations
  // ========================================================================

  async listAssets(): Promise<UnifiedAsset[]> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "RGB_LN", "NOT_CONNECTED");
    }

    const client = kaleidoClientManager.getClient();

    // Get node assets (always works if node is connected)
    let nodeAssetsArray: Record<string, unknown>[] = [];
    if (kaleidoClientManager.hasNode()) {
      try {
        const nodeAssets = await client.rln.listAssets();

        // ListAssetsResponse is an object with nia, uda, cfa arrays
        const nodeAssetsResponse = nodeAssets as {
          nia?: Record<string, unknown>[];
          uda?: Record<string, unknown>[];
          cfa?: Record<string, unknown>[];
        };
        nodeAssetsArray = [
          ...(nodeAssetsResponse.nia || []),
          ...(nodeAssetsResponse.uda || []),
          ...(nodeAssetsResponse.cfa || []),
        ];

        log.info("[RgbAdapter] Got assets from node via SDK:", nodeAssetsArray.length);
      } catch (error) {
        log.warn("[RgbAdapter] Could not get node assets:", error);
      }
    }

    // Wallet asset lists must reflect wallet-owned node assets only.
    // Maker-listed assets belong to market discovery and should be queried
    // through the dedicated maker APIs used by swap flows.
    if (nodeAssetsArray.length === 0) {
      throw new ProtocolError(
        "No wallet assets available from node",
        "RGB_LN",
        "NO_ASSETS_AVAILABLE",
      );
    }

    return nodeAssetsArray.map((asset) => convertNodeAssetToUnified(asset));
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets();
    const asset = assets.find((a) => a.id === assetId || a.ticker === assetId);
    if (!asset) {
      throw new ProtocolError(`Asset not found: ${assetId}`, "RGB_LN", "ASSET_NOT_FOUND");
    }

    return asset;
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset["balance"]> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }

    if (!assetId || !assetId.trim()) {
      throw new ProtocolError("Asset ID is required", "RGB_LN", "INVALID_ASSET_ID");
    }

    try {
      const client = kaleidoClientManager.getClient();

      // Check if requesting BTC balance
      if (assetId === "BTC" || assetId.toLowerCase() === "btc") {
        const btcBalance = await client.rln.getBtcBalance();
        return convertBtcBalance(btcBalance);
      }

      // Get RGB asset balance
      const balanceData = await client.rln.getAssetBalance({
        asset_id: assetId,
      });
      return convertSdkBalance(balanceData);
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to get asset balance");
    }
  }

  async refreshBalances(): Promise<void> {
    if (!kaleidoClientManager.hasNode()) return;

    try {
      const client = kaleidoClientManager.getClient() as unknown as {
        refreshTransfers?: (request: { skip_sync: boolean }) => Promise<unknown>;
        rln?: {
          refreshTransfers?: (request: { skip_sync: boolean }) => Promise<unknown>;
        };
      };
      const refreshTransfers =
        client.rln?.refreshTransfers?.bind(client.rln) ?? client.refreshTransfers?.bind(client);

      if (refreshTransfers) {
        await refreshTransfers({ skip_sync: false });
      }
    } catch (error) {
      log.warn("[RgbAdapter] Could not refresh transfers:", error);
    }
  }

  // ========================================================================
  // Transaction Operations
  // ========================================================================

  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }

    try {
      const client = kaleidoClientManager.getClient();

      // listTransfers requires asset_id for RGB on-chain transfers
      if (!filter?.asset) {
        throw new ProtocolError(
          "Asset ID is required for listing RGB transfers",
          "RGB_LN",
          "ASSET_ID_REQUIRED",
        );
      }

      // Fetch on-chain transfers, Lightning payments AND swaps in parallel.
      // RGB assets can move via all three rails; the asset card needs to
      // surface all of them. listPayments() and listSwaps() return ALL
      // entries — filter client-side by asset_id.
      const [transfersResponse, paymentsResponse, swapsResponse] = await Promise.all([
        client.rln.listTransfers({ asset_id: filter.asset }) as Promise<{
          transfers?: Record<string, unknown>[];
        }>,
        client.rln.listPayments().catch(() => ({ payments: [] })) as Promise<{
          payments?: Record<string, unknown>[];
        }>,
        client.rln.listSwaps().catch(() => ({ maker: [], taker: [] })) as Promise<{
          maker?: Record<string, unknown>[];
          taker?: Record<string, unknown>[];
        }>,
      ]);

      const transferTxs = (transfersResponse.transfers ?? []).map((transfer) =>
        convertTransferToTransaction(transfer),
      );

      const paymentTxs = (paymentsResponse.payments ?? [])
        .filter((payment) => {
          const paymentAssetId = payment.asset_id as string | null | undefined;
          // Match BTC payments to BTC, RGB payments to their asset_id.
          if (filter.asset === "BTC" || filter.asset?.toLowerCase() === "btc") {
            return !paymentAssetId;
          }
          return paymentAssetId === filter.asset;
        })
        .map((payment) => convertPaymentToTransaction(payment));

      const isAssetBtc = filter.asset === "BTC" || filter.asset?.toLowerCase() === "btc";
      const matchesSwapAsset = (swap: Record<string, unknown>): boolean => {
        const fromAsset = (swap.from_asset as string | null | undefined) ?? null;
        const toAsset = (swap.to_asset as string | null | undefined) ?? null;
        // BTC side of a swap is encoded as a missing asset_id.
        if (isAssetBtc) return fromAsset === null || toAsset === null;
        return fromAsset === filter.asset || toAsset === filter.asset;
      };
      const swapTxs = [
        ...(swapsResponse.maker ?? [])
          .filter(matchesSwapAsset)
          .map((swap) => convertSwapToTransaction(swap, "maker")),
        ...(swapsResponse.taker ?? [])
          .filter(matchesSwapAsset)
          .map((swap) => convertSwapToTransaction(swap, "taker")),
      ];

      const merged = [...transferTxs, ...paymentTxs, ...swapTxs];

      return merged
        .filter((tx: UnifiedTransaction) => {
          if (filter.type && tx.type !== filter.type) return false;
          if (filter.status && tx.status !== filter.status) return false;
          if (filter.fromTimestamp && tx.timestamp < filter.fromTimestamp) return false;
          if (filter.toTimestamp && tx.timestamp > filter.toTimestamp) return false;
          return true;
        })
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(filter?.offset || 0, (filter?.offset || 0) + (filter?.limit || 100));
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to list transactions");
    }
  }

  async getTransaction(txId: string, assetId?: string): Promise<UnifiedTransaction> {
    if (!assetId) {
      throw new ProtocolError(
        "Asset ID is required to look up an RGB transaction",
        "RGB_LN",
        "ASSET_ID_REQUIRED",
      );
    }
    const transactions = await this.listTransactions({ asset: assetId });
    const tx = transactions.find((t) => t.id === txId);

    if (!tx) {
      throw new ProtocolError(`Transaction not found: ${txId}`, "RGB_LN", "TX_NOT_FOUND");
    }

    return tx;
  }

  // ========================================================================
  // Payment Operations
  // ========================================================================

  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }

    try {
      const client = kaleidoClientManager.getClient();

      // Create Lightning invoice (BTC or RGB over Lightning)
      // Build params - always include expiry_sec
      const lnInvoiceParams: LNInvoiceRequest = {
        expiry_sec: request.expirySeconds || 3600, // Default to 1 hour
      };

      // Include asset fields if provided (for RGB Lightning invoices)
      const isRgbInvoice = request.asset && request.asset !== "BTC" && request.asset !== "btc";

      if (isRgbInvoice) {
        lnInvoiceParams.asset_id = request.asset;
        if (request.assetAmount && request.assetAmount > 0) {
          lnInvoiceParams.asset_amount = request.assetAmount;
        }
        // The node requires amt_msat >= 3000000 for ANY RGB Lightning invoice,
        // even zero-amount ones where asset_amount is omitted.
        const RGB_HTLC_MIN_MSAT = 3000000; // 3000 sats in msats
        const requestedMsat = request.amount && request.amount > 0 ? request.amount * 1000 : 0;
        lnInvoiceParams.amt_msat = Math.max(requestedMsat, RGB_HTLC_MIN_MSAT);
      } else {
        // BTC Lightning invoice — only include amt_msat if amount is provided
        if (request.amount && request.amount > 0) {
          lnInvoiceParams.amt_msat = request.amount * 1000;
        }
      }

      const lnInvoice = (await client.rln.createLNInvoice(
        lnInvoiceParams,
      )) as CreateLNInvoiceResponse & { payment_hash?: string };

      return {
        invoice: lnInvoice.invoice ?? "",
        paymentHash: lnInvoice.payment_hash ?? "",
        amount: request.amount,
        expiresAt: Date.now() + (request.expirySeconds || 3600) * 1000,
        description: request.description,
      };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to create invoice");
    }
  }

  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }

    try {
      const client = kaleidoClientManager.getClient();
      const decoded = (await client.rln.decodeLNInvoice({ invoice })) as DecodeLNInvoiceResponse & {
        description?: string;
      };

      const amtMsat = decoded.amt_msat;
      return {
        paymentHash: decoded.payment_hash ?? "",
        amount: amtMsat != null ? amtMsat / 1000 : undefined,
        amountMsat: amtMsat ?? undefined,
        description: decoded.description,
        expiresAt: decoded.expiry_sec ? Date.now() + decoded.expiry_sec * 1000 : 0,
        destination: decoded.payee_pubkey || "",
        asset_id: decoded.asset_id ?? undefined,
        asset_amount: decoded.asset_amount ?? undefined,
        payment_hash: decoded.payment_hash,
        amount_msat: decoded.amt_msat ?? undefined,
      };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to decode invoice");
    }
  }

  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }

    try {
      const client = kaleidoClientManager.getClient();
      const sendParams: Record<string, unknown> = {
        invoice: request.invoice,
      };
      // Forward `amt_msat` only for amountless invoices. Previously this
      // truthy-check forwarded any positive `request.amount`, silently
      // re-amounting amount-bearing invoices.
      if (request.amount && request.amount > 0) {
        let invoiceIsAmountless = false;
        try {
          const decoded = await this.decodeInvoice(request.invoice);
          invoiceIsAmountless = !decoded.amount_msat && !decoded.amountMsat && !decoded.amount;
        } catch {
          // If decode fails, err on the side of not overriding.
          invoiceIsAmountless = false;
        }
        if (invoiceIsAmountless) {
          sendParams.amt_msat = request.amount * 1000;
        }
      }
      const result = (await (
        client.rln.sendPayment as (body: Record<string, unknown>) => Promise<unknown>
      )(sendParams)) as SendPaymentResponse & {
        payment_preimage?: string;
        amount_msat?: number;
        fee_msat?: number;
      };

      return {
        paymentHash: result.payment_hash ?? "",
        preimage: result.payment_preimage,
        amount: result.amount_msat ? result.amount_msat / 1000 : 0,
        fee: result.fee_msat ? result.fee_msat / 1000 : 0,
        status: mapPaymentStatus(result.status),
        timestamp: Date.now(),
      };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to send payment");
    }
  }

  async payKeysend(request: KeysendRequest): Promise<PaymentResult> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }

    try {
      const client = kaleidoClientManager.getClient();
      const result = (await client.rln.keysend({
        dest_pubkey: request.pubkey,
        amt_msat: request.amount,
        asset_id: request.assetId,
        asset_amount: request.assetAmount,
      })) as KeysendResponse;

      return {
        paymentHash: result.payment_hash ?? "",
        preimage: result.payment_preimage,
        amount: request.amount / 1000,
        fee: 0,
        status: mapPaymentStatus(result.status),
        timestamp: Date.now(),
      };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to send keysend payment");
    }
  }

  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }

    try {
      const client = kaleidoClientManager.getClient();
      const response = (await client.rln.getPayment({
        payment_hash: paymentHash,
      })) as Record<string, unknown>;
      // The response may be the payment directly or wrapped in a { payment } object
      const payment = (response.payment ?? response) as {
        status?: string;
        amount_msat?: number;
        fee_msat?: number;
        created_at?: number;
      };

      return {
        paymentHash,
        status: mapPaymentStatus(payment.status),
        amount: payment.amount_msat ? payment.amount_msat / 1000 : undefined,
        fee: payment.fee_msat ? payment.fee_msat / 1000 : undefined,
        timestamp: payment.created_at,
      };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to get payment status");
    }
  }

  // ========================================================================
  // Address Operations
  // ========================================================================

  async getReceiveAddress(assetId?: string): Promise<Address> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }

    try {
      const client = kaleidoClientManager.getClient();
      const addressData = (await client.rln.getAddress()) as { address?: string };

      return {
        address: addressData.address ?? "",
        format: "BTC_ADDRESS",
        asset: assetId,
      };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to get receive address");
    }
  }

  // ========================================================================
  // Node & Balance Operations
  // ========================================================================

  async getNodeInfo(): Promise<NodeInfo> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
    try {
      const client = kaleidoClientManager.getClient();
      return await client.rln.getNodeInfo();
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to get node info");
    }
  }

  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
    try {
      const client = kaleidoClientManager.getClient();
      const btcBalance = await client.rln.getBtcBalance();
      const vanilla = btcBalance?.vanilla || {};
      const colored = btcBalance?.colored || {};

      const spendableVanilla = vanilla.spendable || 0;
      const spendableColored = colored.spendable || 0;
      const futureVanilla = vanilla.future || 0;
      const futureColored = colored.future || 0;

      const confirmed = spendableVanilla + spendableColored;
      // `future` is the expected balance after all pending txs settle.
      // Pending incoming = amount above spendable; pending outgoing reduces future below spendable.
      const futureTotal = futureVanilla + futureColored;
      const unconfirmed = Math.max(futureTotal - confirmed, 0);

      return { confirmed, unconfirmed, total: futureTotal };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to get BTC balance");
    }
  }

  async listChannels(): Promise<unknown[]> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
    try {
      const client = kaleidoClientManager.getClient();
      const response = (await client.rln.listChannels()) as
        | unknown[]
        | { channels?: unknown[] }
        | undefined;
      if (Array.isArray(response)) return response;
      if (response && "channels" in response && Array.isArray(response.channels)) {
        return response.channels;
      }
      return [];
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to list channels");
    }
  }

  async listPayments(): Promise<unknown> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
    try {
      const client = kaleidoClientManager.getClient();
      return await client.rln.listPayments();
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to list payments");
    }
  }

  async listTransfers(options?: { asset_id?: string }): Promise<unknown> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
    try {
      const client = kaleidoClientManager.getClient();
      if (!options?.asset_id) {
        return { transfers: [] } as ListTransfersResponse;
      }
      return await client.rln.listTransfers({ asset_id: options.asset_id });
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to list transfers");
    }
  }

  // ========================================================================
  // RGB-Specific Operations
  // ========================================================================

  async createRgbInvoice(params: Record<string, unknown>): Promise<unknown> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
    try {
      const client = kaleidoClientManager.getClient();
      const durationSeconds = ((params.durationSeconds as number) ||
        (params.duration_seconds as number) ||
        3600) as number;
      const invoiceReq = {
        asset_id: ((params.assetId as string) || (params.asset_id as string)) as string,
        expiration_timestamp: Math.floor(Date.now() / 1000) + durationSeconds,
        min_confirmations: ((params.minConfirmations as number) ||
          (params.min_confirmations as number) ||
          1) as number,
        witness: ((params.witness as boolean) ?? true) as boolean,
        ...(params.assignment ? { assignment: params.assignment } : {}),
      };
      return await (client.rln.createRgbInvoice as (body: unknown) => Promise<unknown>)(invoiceReq);
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to create RGB invoice");
    }
  }

  async createRgbUtxos(
    params: {
      num?: number;
      size?: number;
      feeRate?: number;
      upTo?: boolean;
    } = {},
  ): Promise<{ success: boolean }> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
    try {
      const client = kaleidoClientManager.getClient();
      await client.rln.createUtxos({
        up_to: params.upTo ?? false,
        num: params.num ?? 3,
        size: params.size ?? 3000,
        fee_rate: await this.resolveFeeRate(params.feeRate, "normal"),
        skip_sync: false,
      });
      return { success: true };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to create RGB UTXOs");
    }
  }

  async listRgbUnspents(): Promise<{
    unspents: Array<{
      utxo: { outpoint: string; btc_amount: number; colorable: boolean };
      rgb_allocations: Array<{
        asset_id?: string | null;
        assignment: unknown;
        settled: boolean;
      }>;
    }>;
  }> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
    try {
      const client = kaleidoClientManager.getClient();
      const response = await client.rln.listUnspents();
      return response as unknown as Awaited<ReturnType<RgbAdapter["listRgbUnspents"]>>;
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to list unspent outputs");
    }
  }

  /**
   * Resolve a sat/vB fee rate to use for an RGB on-chain operation.
   *
   * Thin wrapper around {@link resolveRgbFeeRatePolicy} that provides the
   * `estimateFn` and `network` from the live adapter state. The pure
   * policy lives outside the class so it can be unit-tested without
   * spinning up a kaleido client.
   *
   * Closes [GL #26] for the RGB adapter — previously every RGB on-chain
   * spend used a hardcoded `1` (createUtxos) or `5` (sendAsset, sendBtc)
   * which is a regtest-era default. On a busy mainnet mempool that's
   * effectively "never confirms".
   */
  private async resolveFeeRate(
    provided: number | undefined,
    urgency: FeeUrgency = "normal",
  ): Promise<number> {
    return resolveRgbFeeRatePolicy({
      provided,
      urgency,
      network: this.config?.network ?? null,
      estimateFn: async (blocks) => {
        try {
          const { fee_rate } = await this.estimateRgbFee(blocks);
          return fee_rate;
        } catch (err) {
          log.warn(
            `[RgbAdapter] fee estimation failed (urgency=${urgency}, blocks=${blocks}):`,
            err,
          );
          return null;
        }
      },
    });
  }

  async estimateRgbFee(blocks: number): Promise<{ fee_rate: number }> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
    try {
      const client = kaleidoClientManager.getClient();
      const response = await client.rln.estimateFee({ blocks });
      return { fee_rate: response?.fee_rate ?? 1 };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to estimate fee");
    }
  }

  async getRgbDetailedBalance(): Promise<{
    vanilla: { settled: number; future: number; spendable: number };
    colored: { settled: number; future: number; spendable: number };
  }> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
    try {
      const client = kaleidoClientManager.getClient();
      const balance = await client.rln.getBtcBalance();
      const empty = { settled: 0, future: 0, spendable: 0 };
      return {
        vanilla: balance?.vanilla ?? empty,
        colored: balance?.colored ?? empty,
      };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to get detailed BTC balance");
    }
  }

  async decodeRgbInvoice(params: Record<string, unknown>): Promise<unknown> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
    try {
      const client = kaleidoClientManager.getClient();
      return await client.rln.decodeRgbInvoice({
        invoice: (params.invoice as string) || (params as unknown as string),
      });
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to decode RGB invoice");
    }
  }

  async getInvoiceStatus(params: { invoice: string }): Promise<unknown> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
    try {
      const client = kaleidoClientManager.getClient();
      return await client.rln.getInvoiceStatus(params);
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to get invoice status");
    }
  }

  async sendAsset(params: Record<string, unknown>): Promise<unknown> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
    try {
      const client = kaleidoClientManager.getClient();
      const assetId = ((params.assetId as string) || (params.asset_id as string)) as string;
      const assignmentObj = params.assignment as Record<string, unknown> | undefined;
      const amount = (params.amount ?? assignmentObj?.value) as number | undefined;
      // The SDK always requires an assignment; derive it from amount when not explicitly provided
      const assignment =
        params.assignment ?? (amount != null ? { type: "Fungible", value: amount } : undefined);
      const sendReq = {
        donation: (params.donation as boolean) || false,
        fee_rate: await this.resolveFeeRate(
          (params.feeRate ?? params.fee_rate) as number | undefined,
          "normal",
        ),
        min_confirmations: 1,
        recipient_map: {
          [assetId]: [
            {
              recipient_id: ((params.recipientId as string) ||
                (params.recipient_id as string)) as string,
              assignment,
              transport_endpoints: ((params.transportEndpoints as string[]) ||
                (params.transport_endpoints as string[]) ||
                []) as string[],
              ...(params.witness_data ? { witness_data: params.witness_data } : {}),
            },
          ],
        },
        skip_sync: false,
      };
      return await (client.rln.sendRgb as (body: unknown) => Promise<unknown>)(sendReq);
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to send RGB asset");
    }
  }

  async sendBtcOnchain(params: {
    address: string;
    amount: number;
    feeRate?: number;
  }): Promise<unknown> {
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
    try {
      const client = kaleidoClientManager.getClient();
      return await client.rln.sendBtc({
        address: params.address,
        amount: params.amount,
        fee_rate: await this.resolveFeeRate(params.feeRate, "normal"),
        skip_sync: false,
      });
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to send BTC on-chain");
    }
  }
  // ========================================================================
  // Swap Operations
  // ========================================================================

  supportsSwaps(): boolean {
    // Swaps via Kaleidoswap require a configured maker URL — without one
    // every quote request errors. The UI must reflect that.
    return !!this.config?.makerUrl;
  }

  async getSwapQuote(request: QuoteRequest): Promise<Quote> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "RGB_LN", "NOT_CONNECTED");
    }

    // Check if maker is configured
    if (!this.config?.makerUrl) {
      throw new ProtocolError(
        "Maker API not configured. Swaps are not available in node-only mode.",
        "RGB_LN",
        "MAKER_NOT_CONFIGURED",
      );
    }

    try {
      const client = kaleidoClientManager.getClient();
      const quoteResponse = (await client.maker.getQuote({
        from_asset: {
          asset_id: request.fromAsset,
          layer: SdkLayer.RGB_LN,
          amount: request.fromAmount,
        },
        to_asset: {
          asset_id: request.toAsset,
          layer: SdkLayer.RGB_LN,
          amount: request.toAmount,
        },
      })) as unknown as {
        rfq_id: string;
        from_asset: { asset_id: string; amount?: string | number };
        to_asset: { asset_id: string; amount?: string | number };
        price: number;
        fee: { final_fee: number; fee_asset: string; base_fee: number; variable_fee: number };
        expires_at: number;
      };

      return {
        id: quoteResponse.rfq_id,
        fromAsset: quoteResponse.from_asset.asset_id,
        fromAmount: Number(quoteResponse.from_asset.amount || 0),
        toAsset: quoteResponse.to_asset.asset_id,
        toAmount: Number(quoteResponse.to_asset.amount || 0),
        price: quoteResponse.price,
        fee: {
          amount: quoteResponse.fee.final_fee,
          asset: quoteResponse.fee.fee_asset,
          breakdown: {
            baseFee: quoteResponse.fee.base_fee,
            variableFee: quoteResponse.fee.variable_fee,
            networkFee: 0,
          },
        },
        expiresAt: quoteResponse.expires_at,
        provider: "Kaleidoswap",
      };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Maker API connection failed");
    }
  }

  async executeSwap(quote: Quote): Promise<SwapResult> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "RGB_LN", "NOT_CONNECTED");
    }

    // Check if maker is configured
    if (!this.config?.makerUrl) {
      throw new ProtocolError(
        "Maker API not configured. Swaps are not available in node-only mode.",
        "RGB_LN",
        "MAKER_NOT_CONFIGURED",
      );
    }

    try {
      const client = kaleidoClientManager.getClient();
      const quoteAny = quote as Quote & {
        rfqId?: string;
        fromLayer?: string;
        toLayer?: string;
        receiverAddress?: string;
      };
      const quote_request = {
        rfq_id: quoteAny.rfqId || quote.id || "",
        from_asset: {
          asset_id: quote.fromAsset,
          amount: quote.fromAmount,
          layer: quoteAny.fromLayer || "RGB_LN",
        },
        to_asset: {
          asset_id: quote.toAsset,
          amount: quote.toAmount,
          layer: quoteAny.toLayer || "RGB_LN",
        },
        receiver_address: {
          address: quoteAny.receiverAddress || "",
          format: "BTC_ADDRESS" as const,
        },
        min_onchain_conf: 1,
        refund_address: "",
        email: "",
      } as CreateSwapOrderRequest;
      const result = await client.maker.createSwapOrder(quote_request);
      const swapResult = result as CreateSwapOrderResponse &
        Record<string, unknown> & { payment_hash?: string };
      const swapId = (swapResult.order_id ?? swapResult.id ?? "") as string;
      if (swapId && swapResult.access_token) {
        this.swapAccessTokens.set(swapId, swapResult.access_token);
      }

      return {
        swapId,
        paymentHash: (swapResult.payment_hash ?? "") as string,
        status: mapSwapStatus(swapResult.status as string | undefined),
        quote,
        timestamp: Date.now(),
      };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to execute swap");
    }
  }

  async getSwapStatus(swapId: string): Promise<SwapResult> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "RGB_LN", "NOT_CONNECTED");
    }

    try {
      const client = kaleidoClientManager.getClient();
      const accessToken = this.swapAccessTokens.get(swapId);
      if (!accessToken) {
        throw new ProtocolError(
          "Missing swap access token for status lookup",
          "RGB_LN",
          "SWAP_ACCESS_TOKEN_MISSING",
        );
      }
      const status = (await client.maker.getSwapOrderStatus({
        order_id: swapId,
        access_token: accessToken,
      })) as SwapOrderStatusResponse & Record<string, unknown>;
      const order = (status.order ?? status) as { status?: string; created_at?: number };

      return {
        swapId,
        status: mapSwapStatus(order.status),
        quote: {} as Quote, // Would need to store original quote
        timestamp: order.created_at || Date.now(),
      };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to get swap status");
    }
  }

  // ========================================================================
  // SDK ↔ unified-shape converters moved to ./converters.ts (this-free;
  // covered by tests/unit/rgb-converters.test.ts).
  // ========================================================================

  // Pure mappers + formatAmount moved to ./helpers.ts (this-free; covered
  // by tests/unit/rgb-helpers.test.ts).

  // ========================================================================
  // Error Handling
  // ========================================================================

  private handleSdkError(error: unknown, context: string): never {
    if (error instanceof NodeNotConfiguredError) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    } else if (error instanceof QuoteExpiredError) {
      throw new ProtocolError("Quote expired", "RGB_LN", "QUOTE_EXPIRED");
    } else if (error instanceof SdkInsufficientBalanceError) {
      throw new InsufficientBalanceError("Insufficient balance", "RGB_LN", 0, 0);
    } else if (error instanceof APIError) {
      throw new ProtocolError(`${context}: ${error.message}`, "RGB_LN", "API_ERROR", error);
    } else if (error instanceof NetworkError) {
      throw new ConnectionError(`${context}: Network error - ${error.message}`, "RGB_LN", error);
    } else if (error instanceof KaleidoError) {
      throw new ProtocolError(`${context}: ${error.message}`, "RGB_LN", "SDK_ERROR", error);
    }

    // Default error handling
    const msg = error instanceof Error ? error.message : "Unknown error";
    throw new ProtocolError(
      `${context}: ${msg}`,
      "RGB_LN",
      "UNKNOWN_ERROR",
      error instanceof Error ? error : undefined,
    );
  }
}
