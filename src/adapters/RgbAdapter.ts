/**
 * RGB Protocol Adapter — implements IProtocolAdapter over the Kaleido SDK.
 */

import { IProtocolAdapter, type ProtocolConfig } from "./IProtocolAdapter";
import { log } from "../lib/log";
import { isBtcAssetId } from "../lib/asset-id";
import { kaleidoClientManager } from "../lib/kaleido-client-manager";
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
import { toSwapAmount, validateSwapQuoteTerms } from "../lib/swap-money";
import { mapPaymentStatus, mapSwapStatus } from "../lib/rgb-helpers";
import { roundedMsatToSat, toSafeAmountNumber } from "../lightning/amounts";
import { decodeBolt11, decodeBolt11Invoice } from "../lib/bolt11";
import {
  convertBtcBalance,
  convertNodeAssetToUnified,
  convertPaymentToTransaction,
  convertSdkBalance,
  convertSwapToTransaction,
  convertTransferToTransaction,
} from "../lib/rgb-converters";
import {
  KaleidoswapSwapStore,
  kaleidoswapNow,
  type KaleidoswapSwapRecord,
} from "../swap/kaleidoswap-swap-store";

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
  private swapStore: KaleidoswapSwapStore | null = null;
  private swapStoreIdentity: string | null = null;
  /** Hot cache only; durable records are authoritative across restarts. */
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
        // `jwt` is the documented NODE-auth credential (types/rgb.ts:28) while
        // `apiKey` is documented as the maker's. Forwarding only `apiKey` meant a
        // host that configured `jwt` per the docs got a node client with no
        // Authorization header and no warning. Same precedence as the WDK path
        // (RlnWdkAdapter.ts:154) so the two backends agree.
        apiKey: rgbConfig.jwt ?? rgbConfig.apiKey,
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
      // FAIL CLOSED. `kaleidoClientManager.initialize()` ran before the
      // `getNodeInfo()` handshake, and the fund-moving methods on this adapter gate
      // on `kaleidoClientManager.hasNode()` — config presence — not on
      // `isConnected()`. So a connect() that threw (bad credentials, version skew)
      // used to leave the manager initialized with the node URL: the host marked
      // the wallet disconnected and hid the send UI, while any code path still
      // holding this adapter could call `sendPayment`/`payKeysend`/`sendAsset`/
      // `sendBtcOnchain` and have it sail through the `hasNode()` guard and pay.
      // Resetting here revokes node access with the failed connect
      // (audit finding G-F6).
      this.connected = false;
      this.config = null;
      kaleidoClientManager.reset();
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
    this.swapStore = null;
    this.swapStoreIdentity = null;
    this.swapAccessTokens.clear();
    log.info("[RgbAdapter] Disconnected");
  }

  isConnected(): boolean {
    return this.connected && kaleidoClientManager.isInitialized();
  }

  private assertNodeConnected(): void {
    // The shared manager can be initialized independently; require this adapter's
    // own successful handshake before any node operation, especially money paths.
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "RGB_LN", "NOT_CONNECTED");
    }
    if (!kaleidoClientManager.hasNode()) {
      throw new ProtocolError("Node not configured", "RGB_LN", "NODE_NOT_CONFIGURED");
    }
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
    // Asset identity in RGB is the contract id ONLY. `ticker` is free text
    // chosen by the issuer, so the old `a.id === assetId || a.ticker === assetId`
    // let an impostor asset shadow a genuine one: an issuer who sets
    // `ticker: 'rgb:real-usdt'` and gets listed first captured even an EXACT
    // CONTRACT-ID lookup, returning their worthless asset (and its balance) to a
    // caller that did the right thing. Match the id first — the three sibling
    // RGB adapters (RlnWdkAdapter, RgbLibWdkAdapter, RgbLibWasmAdapter) are all
    // id-only, which is the intended semantics.
    const byId = assets.find((a) => a.id === assetId);
    if (byId) return byId;
    // Ticker lookup stays available for hosts that resolve a user-visible
    // symbol, but only when it is UNAMBIGUOUS — two assets sharing a ticker is
    // exactly the impostor case, and picking the first-listed one silently
    // prefers whichever the attacker got in front.
    const byTicker = assets.filter((a) => a.ticker === assetId);
    if (byTicker.length === 1) return byTicker[0];
    if (byTicker.length > 1) {
      throw new ProtocolError(
        `Ambiguous asset ticker '${assetId}' — ${byTicker.length} assets share it; look up by contract id`,
        "RGB_LN",
        "AMBIGUOUS_ASSET",
      );
    }
    throw new ProtocolError(`Asset not found: ${assetId}`, "RGB_LN", "ASSET_NOT_FOUND");
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset["balance"]> {
    this.assertNodeConnected();

    if (!assetId || !assetId.trim()) {
      throw new ProtocolError("Asset ID is required", "RGB_LN", "INVALID_ASSET_ID");
    }

    try {
      const client = kaleidoClientManager.getClient();

      // Check if requesting BTC balance
      if (isBtcAssetId(assetId)) {
        const btcBalance = await client.rln.getBtcBalance();
        return convertBtcBalance(btcBalance);
      }

      // Get RGB asset balance AT THE ASSET'S OWN PRECISION. `convertSdkBalance`
      // defaults to 8 (the BTC convention), which silently understates every
      // non-8-precision asset by 10^(8-p) — a precision-0 asset holding 1,000,000
      // units rendered as "0.01000000" — and disagreed with the same asset's
      // `listAssets()` card, which does use the real precision. Metadata is
      // fetched in parallel so this costs no extra round trip.
      const [balanceData, metadata] = await Promise.all([
        client.rln.getAssetBalance({ asset_id: assetId }),
        client.rln.getAssetMetadata({ asset_id: assetId }),
      ]);
      return convertSdkBalance(balanceData, (metadata as { precision?: number })?.precision ?? 8);
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to get asset balance");
    }
  }

  async refreshBalances(): Promise<void> {
    this.assertNodeConnected();

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
      throw error;
    }
  }

  // ========================================================================
  // Transaction Operations
  // ========================================================================

  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    this.assertNodeConnected();

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

      // On-chain transfers, Lightning payments and swaps in parallel: RGB assets
      // move via all three rails. listPayments()/listSwaps() return ALL entries, so
      // filter client-side by asset_id.
      const [transfersResponse, paymentsResponse, swapsResponse] = await Promise.all([
        client.rln.listTransfers({ asset_id: filter.asset }) as Promise<{
          transfers?: Record<string, unknown>[];
        }>,
        // No per-leg `.catch` default. Swallowing a failing rail returned a
        // history silently MISSING every LN payment (or every swap) while
        // presenting it as complete: a user reconciling an asset's balance
        // against its activity sees sats they cannot account for, and nothing
        // signals that a whole rail is absent. The transfers leg above already
        // fails the call; the three now behave alike. (There is no `partial`
        // flag on the result to degrade to — see REPORT-2.)
        client.rln.listPayments() as Promise<{
          payments?: Record<string, unknown>[];
        }>,
        client.rln.listSwaps() as Promise<{
          maker?: Record<string, unknown>[];
          taker?: Record<string, unknown>[];
        }>,
      ]);

      // Resolve every asset whose base units appear in a row, so history renders
      // at the asset's own precision rather than the BTC default of 8 (a 500-unit
      // precision-0 receive displayed as "0.00000500" — and history is what a
      // merchant checks before treating an invoice as paid). Three different
      // assets can be involved: the requested asset for transfers, each payment's
      // own `asset_id`, and each swap's `from_asset`, which need not be the
      // requested one. Deduplicated and fetched in parallel, so a history with
      // one counter-asset costs one extra round trip, not one per row.
      const precisionOf = await this.resolveAssetPrecisions(client, [
        filter.asset,
        ...(paymentsResponse.payments ?? []).map((p) => p.asset_id as string | null | undefined),
        ...[...(swapsResponse.maker ?? []), ...(swapsResponse.taker ?? [])].map(
          (s) => s.from_asset as string | null | undefined,
        ),
      ]);

      const transferTxs = (transfersResponse.transfers ?? []).map((transfer) =>
        convertTransferToTransaction(transfer, precisionOf(filter.asset)),
      );

      const paymentTxs = (paymentsResponse.payments ?? [])
        .filter((payment) => {
          const paymentAssetId = payment.asset_id as string | null | undefined;
          // Match BTC payments to BTC, RGB payments to their asset_id.
          if (isBtcAssetId(filter.asset)) {
            return !paymentAssetId;
          }
          return paymentAssetId === filter.asset;
        })
        .map((payment) =>
          convertPaymentToTransaction(payment, precisionOf(payment.asset_id as string | null)),
        );

      const isAssetBtc = isBtcAssetId(filter.asset);
      const matchesSwapAsset = (swap: Record<string, unknown>): boolean => {
        const fromAsset = (swap.from_asset as string | null | undefined) ?? null;
        const toAsset = (swap.to_asset as string | null | undefined) ?? null;
        // BTC side of a swap is encoded as a missing asset_id.
        if (isAssetBtc) return fromAsset === null || toAsset === null;
        return fromAsset === filter.asset || toAsset === filter.asset;
      };
      // `qty_from` is in the swap's FROM asset, which on a to-leg match is the
      // counter-asset, not `filter.asset`.
      const swapPrecision = (swap: Record<string, unknown>): number =>
        precisionOf(swap.from_asset as string | null);
      const swapTxs = [
        ...(swapsResponse.maker ?? [])
          .filter(matchesSwapAsset)
          .map((swap) => convertSwapToTransaction(swap, "maker", swapPrecision(swap))),
        ...(swapsResponse.taker ?? [])
          .filter(matchesSwapAsset)
          .map((swap) => convertSwapToTransaction(swap, "taker", swapPrecision(swap))),
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

  /**
   * Resolve the display precision of each asset a history call renders amounts
   * in, as a lookup keyed by asset id.
   *
   * BTC — which the node encodes as a missing/`"BTC"` asset id — is 8 by
   * definition and costs no round trip. Every other id is looked up once via
   * `getAssetMetadata`, deduplicated, in parallel. A response that omits
   * `precision` falls back to 8, matching `getAssetBalance` (41bc6bf); a lookup
   * that THROWS fails the whole call, matching this method's own rail policy
   * (e92aa0b) — a history rendered at a fabricated precision is wrong in the same
   * silent way as one missing a rail, and there is no `partial` flag to degrade to.
   */
  private async resolveAssetPrecisions(
    client: ReturnType<typeof kaleidoClientManager.getClient>,
    assetIds: (string | null | undefined)[],
  ): Promise<(assetId: string | null | undefined) => number> {
    const isBtc = (id: string | null | undefined): boolean => !id || isBtcAssetId(id);

    const wanted = [...new Set(assetIds.filter((id) => !isBtc(id)) as string[])];
    const entries = await Promise.all(
      wanted.map(async (assetId) => {
        const metadata = (await client.rln.getAssetMetadata({ asset_id: assetId })) as {
          precision?: number;
        };
        return [assetId, metadata?.precision ?? 8] as const;
      }),
    );
    const byId = new Map<string, number>(entries);

    return (assetId) => (isBtc(assetId) ? 8 : (byId.get(assetId as string) ?? 8));
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
    this.assertNodeConnected();

    try {
      const client = kaleidoClientManager.getClient();

      // Create Lightning invoice (BTC or RGB over Lightning)
      // Build params - always include expiry_sec
      const lnInvoiceParams: LNInvoiceRequest = {
        expiry_sec: request.expirySeconds || 3600, // Default to 1 hour
      };

      // Include asset fields if provided (for RGB Lightning invoices)
      const isRgbInvoice = request.asset && !isBtcAssetId(request.asset);

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

      const lnInvoice = await client.rln.createLNInvoice(lnInvoiceParams);
      const paymentHash = decodeBolt11Invoice(lnInvoice.invoice).paymentHash;

      return {
        invoice: lnInvoice.invoice ?? "",
        paymentHash,
        amount: request.amount,
        expiresAt: Date.now() + (request.expirySeconds || 3600) * 1000,
        description: request.description,
      };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to create invoice");
    }
  }

  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    this.assertNodeConnected();

    try {
      const client = kaleidoClientManager.getClient();
      const decoded = (await client.rln.decodeLNInvoice({ invoice })) as DecodeLNInvoiceResponse & {
        description?: string;
      };

      const amtMsat = decoded.amt_msat;
      return {
        paymentHash: decoded.payment_hash ?? "",
        amount: amtMsat != null
          ? toSafeAmountNumber(roundedMsatToSat(String(amtMsat)), "sat")
          : undefined,
        amountMsat: amtMsat ?? undefined,
        description: decoded.description,
        expiresAt: decoded.expiry_sec
          ? (Number(decoded.timestamp) + Number(decoded.expiry_sec)) * 1000
          : 0,
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
    this.assertNodeConnected();

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
      )(sendParams)) as SendPaymentResponse;
      const invoiceAmount = decodeBolt11(request.invoice).amountSat;

      return {
        paymentHash: result.payment_hash ?? "",
        // SendPaymentResponse has no amount or fee. The BOLT11 amount is the
        // authoritative source because amount-bearing invoices are not re-amounted.
        amount: invoiceAmount ?? request.amount ?? 0,
        fee: 0,
        status: mapPaymentStatus(result.status),
        timestamp: Date.now(),
      };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to send payment");
    }
  }

  async payKeysend(request: KeysendRequest): Promise<PaymentResult> {
    this.assertNodeConnected();

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
    this.assertNodeConnected();

    try {
      const client = kaleidoClientManager.getClient();
      const response = await client.rln.getPayment({
        payment_hash: paymentHash,
      });
      const payment = response.payment;

      return {
        paymentHash,
        status: mapPaymentStatus(payment.status),
        amount: payment.amt_msat != null
          ? toSafeAmountNumber(roundedMsatToSat(String(payment.amt_msat)), "sat")
          : undefined,
        // The declared Payment shape carries no routing-fee field.
        fee: undefined,
        timestamp: payment.created_at ? payment.created_at * 1000 : undefined,
      };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to get payment status");
    }
  }

  // ========================================================================
  // Address Operations
  // ========================================================================

  async getReceiveAddress(assetId?: string): Promise<Address> {
    this.assertNodeConnected();

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
    this.assertNodeConnected();
    try {
      const client = kaleidoClientManager.getClient();
      return await client.rln.getNodeInfo();
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to get node info");
    }
  }

  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    this.assertNodeConnected();
    try {
      const client = kaleidoClientManager.getClient();
      const btcBalance = await client.rln.getBtcBalance();
      const vanilla = btcBalance?.vanilla || {};

      // Vanilla only. "Colored" sats sit under RGB asset allocations and cannot be
      // spent as ordinary BTC — `convertBtcBalance` (rgb-converters.ts) states the
      // same policy in its doc comment and returns vanilla only, so summing them
      // here made one adapter report two different BTC balances for identical node
      // state (`getAssetBalance('BTC')` → 5000 vs `getBtcBalance()` → 7000). The
      // overstated figure is the one a host uses to bound a send or a "max" button.
      // Colored sats remain visible per-asset and via `getRgbDetailedBalance()`.
      const confirmed = vanilla.spendable || 0;
      // `future` is the expected balance after all pending txs settle.
      // Pending incoming = amount above spendable; pending outgoing reduces future below spendable.
      const futureTotal = vanilla.future || 0;
      const unconfirmed = Math.max(futureTotal - confirmed, 0);

      return { confirmed, unconfirmed, total: futureTotal };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to get BTC balance");
    }
  }

  async listChannels(): Promise<unknown[]> {
    this.assertNodeConnected();
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
    this.assertNodeConnected();
    try {
      const client = kaleidoClientManager.getClient();
      return await client.rln.listPayments();
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to list payments");
    }
  }

  async listTransfers(options?: { asset_id?: string }): Promise<unknown> {
    this.assertNodeConnected();
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
    this.assertNodeConnected();
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
    this.assertNodeConnected();
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
    this.assertNodeConnected();
    try {
      const client = kaleidoClientManager.getClient();
      const response = await client.rln.listUnspents();
      return response as unknown as Awaited<ReturnType<RgbAdapter["listRgbUnspents"]>>;
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to list unspent outputs");
    }
  }

  /**
   * Resolve a sat/vB fee rate for an RGB on-chain operation. Thin wrapper around
   * {@link resolveRgbFeeRatePolicy}, supplying `estimateFn` and `network` from live
   * adapter state; the pure policy lives outside the class so it is unit-testable.
   *
   * Closes [GL #26]: RGB on-chain spends previously used a hardcoded regtest-era
   * `1`/`5`, which on a busy mainnet mempool means "never confirms".
   */
  private async resolveFeeRate(
    provided: number | undefined,
    urgency: FeeUrgency = "normal",
  ): Promise<number> {
    return resolveRgbFeeRatePolicy({
      provided,
      urgency,
      // An ABSENT network must fail toward the mainnet floor, not away from it.
      // `BaseProtocolConfig.network` is optional with no documented default, and
      // the policy maps an unknown network to 1 sat/vB (documented, and correct
      // for regtest/signet). A host that omits `network` while pointed at a
      // mainnet node therefore built real mainnet transactions at 1 sat/vB —
      // unconfirmable, with no engine-level RBF path, locking the wallet's UTXOs
      // and RGB allocations. Both WDK RGB adapters already default an absent
      // network to 'mainnet' (RlnWdkAdapter.ts:143, RgbLibWasmAdapter.ts:158);
      // this is that parity. Overpaying on regtest/signet costs nothing.
      network: this.config?.network ?? 'mainnet',
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
    this.assertNodeConnected();
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
    this.assertNodeConnected();
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
    this.assertNodeConnected();
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
    this.assertNodeConnected();
    try {
      const client = kaleidoClientManager.getClient();
      return await client.rln.getInvoiceStatus(params);
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to get invoice status");
    }
  }

  async sendAsset(params: Record<string, unknown>): Promise<unknown> {
    this.assertNodeConnected();
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
    this.assertNodeConnected();
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

  private recordStore(takerPubkey: string): KaleidoswapSwapStore {
    const identity = `${this.config?.network ?? "mainnet"}:${takerPubkey}`;
    if (!this.swapStore || this.swapStoreIdentity !== identity) {
      this.swapStore = new KaleidoswapSwapStore(identity);
      this.swapStoreIdentity = identity;
    }
    return this.swapStore;
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

      const terms = validateSwapQuoteTerms(
        request,
        {
          fromAsset: quoteResponse.from_asset.asset_id,
          toAsset: quoteResponse.to_asset.asset_id,
          fromAmount: quoteResponse.from_asset.amount,
          toAmount: quoteResponse.to_asset.amount,
        },
        this.config.maxQuoteSlippageBps,
      );

      // Money coercion and request authority are shared with the WDK path. The
      // request's asset ids are emitted even after the maker echoes them.
      return {
        id: quoteResponse.rfq_id,
        fromAsset: terms.fromAsset,
        fromAmount: terms.fromAmount,
        toAsset: terms.toAsset,
        toAmount: terms.toAmount,
        price: toSwapAmount(quoteResponse.price, "price"),
        fee: {
          amount: toSwapAmount(quoteResponse.fee?.final_fee, "fee.final_fee"),
          asset: quoteResponse.fee?.fee_asset,
          breakdown: {
            baseFee: toSwapAmount(quoteResponse.fee?.base_fee, "fee.base_fee"),
            variableFee: toSwapAmount(quoteResponse.fee?.variable_fee, "fee.variable_fee"),
            networkFee: 0,
          },
        },
        // Maker reports seconds since epoch; the engine convention is ms.
        expiresAt: toSwapAmount(quoteResponse.expires_at, "expires_at") * 1000,
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

    const rfqId = (quote as Quote & { rfqId?: string }).rfqId || quote.id;
    if (!rfqId) {
      throw new ProtocolError(
        "Swap execution requires the approved quote's rfq id",
        "RGB_LN",
        "NO_QUOTE",
      );
    }
    if (!(quote.fromAmount > 0) || !(quote.toAmount > 0)) {
      throw new ProtocolError(
        "Swap execution requires the approved quote amounts",
        "RGB_LN",
        "NO_AMOUNT",
      );
    }
    // Fail CLOSED on a non-finite expiry. `expiresAt` is `expires_at * 1000` from
    // the maker response, so a maker that omits or renames the field yields NaN —
    // and the old `quote.expiresAt > 0` form made `NaN > 0` false, silently
    // skipping the engine's only client-side expiry check. A counterparty must
    // not be able to switch off a safety check by leaving a field out. (The
    // amount guard directly above is already written NaN-safe; this matches it.)
    if (!Number.isFinite(quote.expiresAt) || quote.expiresAt <= 0) {
      throw new ProtocolError(
        "Approved quote has no usable expiry — request a fresh quote",
        "RGB_LN",
        "QUOTE_EXPIRED",
      );
    }
    if (Date.now() > quote.expiresAt) {
      throw new ProtocolError(
        "Approved quote has expired — request a fresh quote",
        "RGB_LN",
        "QUOTE_EXPIRED",
      );
    }

    let recordStore: KaleidoswapSwapStore | null = null;
    let recordId: string | null = null;
    let executionAttempted = false;
    let quoteClaimed = false;
    try {
      const client = kaleidoClientManager.getClient();
      const rln = client.rln as unknown as {
        whitelistSwap(body: { swapstring: string }): Promise<void>;
        getTakerPubkey(): Promise<string>;
      };
      const takerPubkey = await rln.getTakerPubkey();
      recordStore = this.recordStore(takerPubkey);
      if (!recordStore.tryClaim(rfqId)) {
        throw new ProtocolError(
          `Swap quote ${rfqId} is already executing`,
          "RGB_LN",
          "SWAP_IN_FLIGHT",
          { quoteId: rfqId },
        );
      }
      quoteClaimed = true;
      const previous = await recordStore.getByQuoteId(rfqId);
      if (previous) {
        throw new ProtocolError(
          `Swap quote ${rfqId} was already used`,
          "RGB_LN",
          "SWAP_ALREADY_EXECUTED",
          { quoteId: rfqId, state: previous.state, paymentHash: previous.paymentHash },
        );
      }
      // The maker binds the swap to the rfq_id and these exact raw amounts —
      // there is no server-side re-quote, so the fill can never diverge from
      // the approved quote on either leg.
      const init = await client.maker.initSwap({
        rfq_id: rfqId,
        from_asset: quote.fromAsset,
        from_amount: quote.fromAmount,
        to_asset: quote.toAsset,
        to_amount: quote.toAmount,
      });

      const createdAt = kaleidoswapNow();
      recordId = rfqId;
      await recordStore.save({
        quoteId: rfqId,
        paymentHash: init.payment_hash,
        accessToken: init.access_token ?? undefined,
        fromAsset: quote.fromAsset,
        fromAmount: quote.fromAmount,
        toAsset: quote.toAsset,
        toAmount: quote.toAmount,
        expiresAt: quote.expiresAt,
        createdAt,
        updatedAt: createdAt,
        state: "initialized",
      });

      // Whitelist BEFORE confirming execution: once the maker starts the
      // swap it routes the HTLC immediately, and an un-whitelisted node
      // rejects it. (rln is the NWC client shape in NWC mode, hence `any`.)
      await rln.whitelistSwap({ swapstring: init.swapstring });
      await recordStore.update(rfqId, { state: "whitelisted", updatedAt: kaleidoswapNow() });

      // /swaps/execute responds with an HTTP-style {status: 200, message} —
      // the swap itself starts in 'Waiting'; poll getSwapStatus for truth.
      await recordStore.update(rfqId, { state: "executing", updatedAt: kaleidoswapNow() });
      executionAttempted = true;
      await client.maker.executeSwap({
        swapstring: init.swapstring,
        taker_pubkey: takerPubkey,
        payment_hash: init.payment_hash,
      });

      const accessToken = init.access_token ?? undefined;
      await recordStore.update(rfqId, { state: "pending", updatedAt: kaleidoswapNow() });
      if (accessToken) this.swapAccessTokens.set(init.payment_hash, accessToken);
      return {
        swapId: init.payment_hash,
        paymentHash: init.payment_hash,
        accessToken,
        status: "pending",
        quote,
        timestamp: kaleidoswapNow(),
      };
    } catch (error: unknown) {
      if (executionAttempted && recordStore && recordId) {
        try {
          await recordStore.update(recordId, {
            state: "execution_unknown",
            updatedAt: kaleidoswapNow(),
          });
        } catch (storeError) {
          log.error("[RgbAdapter] Failed to mark an uncertain swap execution:", storeError);
        }
      }
      throw this.handleSdkError(error, "Failed to execute swap");
    } finally {
      if (quoteClaimed && recordStore) recordStore.releaseClaim(rfqId);
    }
  }

  /** `swapId` is the atomic swap's payment hash. */
  async getSwapStatus(swapId: string, accessToken?: string): Promise<SwapResult> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "RGB_LN", "NOT_CONNECTED");
    }

    try {
      const client = kaleidoClientManager.getClient();
      let recordStore = this.swapStore;
      if (!recordStore) {
        try {
          const takerPubkey = await (client.rln as any).getTakerPubkey();
          if (takerPubkey) recordStore = this.recordStore(takerPubkey);
        } catch {
          // Preserve legacy status lookup when an older node cannot expose a
          // public taker identity; caller-supplied tokens still work.
        }
      }
      const record = recordStore ? await recordStore.find(swapId) : null;
      const status = await client.maker.getAtomicSwapStatus({
        payment_hash: swapId,
        access_token: accessToken ?? record?.accessToken ?? this.swapAccessTokens.get(swapId) ?? "",
      });
      const swap = (status.swap ?? status) as {
        status?: string;
        qty_from?: number;
        qty_to?: number;
        from_asset?: string | null;
        to_asset?: string | null;
      };

      const mappedStatus = mapSwapStatus(swap?.status);
      if (recordStore && record) {
        await recordStore.update(record.quoteId, {
          state: mappedStatus,
          updatedAt: kaleidoswapNow(),
        });
      }
      return {
        swapId,
        paymentHash: swapId,
        accessToken: accessToken ?? record?.accessToken,
        status: mappedStatus,
        quote: {
          id: swapId,
          fromAsset: swap?.from_asset ?? "",
          // Same coercion as KaleidoswapSwap.getSwapStatus, `?? 0` and all: a
          // status lookup legitimately predates a fill, so an absent quantity is
          // 0 here rather than an error — but a present, corrupt one still fails.
          fromAmount: toSwapAmount(swap?.qty_from ?? 0, "qty_from"),
          toAsset: swap?.to_asset ?? "",
          toAmount: toSwapAmount(swap?.qty_to ?? 0, "qty_to"),
          price: 0,
          fee: { amount: 0, asset: swap?.from_asset ?? "" },
          expiresAt: 0,
          provider: "Kaleidoswap",
        },
        timestamp: kaleidoswapNow(),
      };
    } catch (error: unknown) {
      throw this.handleSdkError(error, "Failed to get swap status");
    }
  }

  async listIncompleteSwaps(): Promise<KaleidoswapSwapRecord[]> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "RGB_LN", "NOT_CONNECTED");
    }
    const client = kaleidoClientManager.getClient();
    const takerPubkey = await (client.rln as any).getTakerPubkey();
    if (!takerPubkey) {
      throw new ProtocolError(
        "Node did not provide a wallet identity for swap recovery",
        "RGB_LN",
        "SWAP_RECOVERY_UNAVAILABLE",
      );
    }
    return this.recordStore(takerPubkey).listIncomplete();
  }

  async resumeSwap(identifier: string, accessToken?: string): Promise<SwapResult> {
    const records = await this.listIncompleteSwaps();
    const record = records.find(
      (candidate) => candidate.quoteId === identifier || candidate.paymentHash === identifier,
    );
    if (!record?.paymentHash) {
      throw new ProtocolError(
        `Swap ${identifier} has no payment hash and can only be inspected`,
        "RGB_LN",
        "SWAP_RECOVERY_UNAVAILABLE",
        { quoteId: record?.quoteId ?? identifier },
      );
    }
    return this.getSwapStatus(record.paymentHash, accessToken);
  }

  // SDK ↔ unified-shape converters live in ./converters.ts (this-free).

  // Pure mappers + formatAmount moved to ./helpers.ts (this-free; covered
  // by tests/unit/rgb-helpers.test.ts).

  // ========================================================================
  // Error Handling
  // ========================================================================

  private handleSdkError(error: unknown, context: string): never {
    if (error instanceof ProtocolError) {
      throw error;
    } else if (error instanceof NodeNotConfiguredError) {
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
