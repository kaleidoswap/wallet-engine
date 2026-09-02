/**
 * Spark Protocol Adapter
 * Implements IProtocolAdapter using @buildonspark/spark-sdk.
 *
 * SDK amounts are in SATS; balance comes back as bigint.
 */

import { ExitSpeed } from "@buildonspark/spark-sdk/types";
import type { CoopExitFeeQuote } from "@buildonspark/spark-sdk/types";
import type { Bech32mTokenIdentifier, SparkAddressFormat } from "@buildonspark/spark-sdk";
import {
  isValidSparkAddress,
  decodeSparkAddress,
  getNetworkFromSparkAddress,
} from "@buildonspark/spark-sdk";
import { IProtocolAdapter, type ProtocolConfig } from "./IProtocolAdapter";
import { log } from "../lib/log";
import { decodeBolt11 } from "../lib/bolt11";
import {
  type SentTokenTxRecord,
  loadSentTokenRecords,
  normalizeTxHash,
  saveSentTokenRecord,
} from "../lib/spark-sent-token-records";
import { sparkClientManager } from "../lib/spark-client-manager";
import { SparkConfig, SparkTransfer } from "../types/spark";
import { PROTOCOL_OPERATIONS } from "../capabilities/operations";
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
} from "../types/base";
import { resolveWalletSeed } from "../lib/wallet-seed";
import { HDKey } from "@scure/bip32";
import { signLnMessage, verifyLnMessage } from "../lib/ln-message-sign";

/** Default maximum fee for Lightning payments (sats). */
const DEFAULT_MAX_FEE_SATS = 1000;

import { waitForLightningSendSettlement } from "../lib/spark-lightning-settlement";

// Pure helpers live in ./helpers.ts; balance cache state in ./balance-cache.ts.
// Both are re-exported here so existing call sites keep working.
import {
  formatAmount,
  mapTransferStatus,
  parseSdkExpiryMs,
  rawTokenIdFromBech32mTokenId,
  rawTokenIdFromBytes,
  tokenRefsMatch,
  txHashFromBytes,
  withTimeout,
} from "../lib/spark-helpers";
import {
  getSparkBalanceCached,
  invalidateSparkBalanceCache,
  SPARK_RPC_TIMEOUT_MS,
} from "../lib/spark-balance-cache";
import {
  buildSentRecordTransaction,
  convertTokenTransactionToUnified,
  convertTransferToTransaction,
} from "../lib/spark-converters";
export { isEmptyBalance } from "../lib/spark-helpers";
export { invalidateSparkBalanceCache };

/**
 * Spark Protocol Adapter Implementation
 */
export class SparkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = "SPARK";
  readonly supportedLayers: Layer[] = ["SPARK_SPARK", "BTC_LN"];
  readonly version = "1.0.0";
  readonly capabilities = PROTOCOL_OPERATIONS.SPARK;

  private config: SparkConfig | null = null;

  /** Maps Lightning invoice string → LightningReceiveRequest ID for status polling. */
  private invoiceRequestIds = new Map<string, string>();

  // ========================================================================
  // Connection Management
  // ========================================================================

  async connect(config: ProtocolConfig): Promise<void> {
    const sparkConfig = config as SparkConfig;

    if (!sparkConfig.mnemonic) {
      throw new ConnectionError("Mnemonic is required for Spark wallet", "SPARK");
    }

    try {
      await sparkClientManager.initialize(sparkConfig);
      this.config = sparkConfig;
      log.info("[SparkAdapter] Connected to Spark successfully");
    } catch (error: unknown) {
      // Fail CLOSED. On a wallet switch A→B whose connect throws, the client
      // manager has already torn A's wallet down (isConnected() is false), but a
      // `this.config` left over from A's earlier successful connect still holds
      // A's mnemonic — and the signing methods below used to gate on that field
      // alone. Any code path still holding this adapter (an in-flight LNURL-auth
      // challenge, a dapp PSBT request) could then sign with WALLET A's KEYS
      // while every indicator said the wallet was locked.
      this.config = null;
      const msg = error instanceof Error ? error.message : String(error);
      throw new ConnectionError(`Failed to connect to Spark: ${msg}`, "SPARK", error);
    }
  }

  async disconnect(): Promise<void> {
    await sparkClientManager.disconnect();
    this.config = null;
    log.info("[SparkAdapter] Disconnected from Spark");
  }

  isConnected(): boolean {
    return sparkClientManager.isInitialized();
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }

    try {
      const wallet = sparkClientManager.getWallet();
      await getSparkBalanceCached(wallet);

      return {
        protocol: "SPARK",
        connected: true,
        network: this.config?.network || "regtest",
        syncStatus: { synced: true, progress: 100 },
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        `Failed to get connection info: ${msg}`,
        "SPARK",
        "CONNECTION_INFO_ERROR",
        error,
      );
    }
  }

  // ========================================================================
  // Asset Operations
  // ========================================================================

  async listAssets(): Promise<UnifiedAsset[]> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }

    try {
      const wallet = sparkClientManager.getWallet();
      const { balance, tokenBalances } = await getSparkBalanceCached(wallet);
      const balanceSats = Number(balance);

      const btcAsset: UnifiedAsset = {
        id: "BTC",
        name: "Bitcoin",
        ticker: "BTC",
        precision: 8,
        protocol: "SPARK",
        layer: "SPARK_SPARK",
        balance: {
          total: balanceSats,
          available: balanceSats,
          pending: 0,
          locked: 0,
          totalDisplay: formatAmount(balanceSats, 8),
          availableDisplay: formatAmount(balanceSats, 8),
        },
        capabilities: {
          canSend: true,
          canReceive: true,
          canSwap: false,
          supportsLightning: true,
          supportsOnchain: true,
        },
      };

      const assets: UnifiedAsset[] = [btcAsset];

      // Add token assets from Spark's BTKN token standard
      if (tokenBalances && tokenBalances.size > 0) {
        for (const [tokenId, info] of tokenBalances) {
          const { tokenMetadata: meta } = info;
          const owned = Number(info.ownedBalance);
          const available = Number(info.availableToSendBalance);
          const precision = meta.decimals ?? 8;

          assets.push({
            id: tokenId,
            name: meta.tokenName,
            ticker: meta.tokenTicker,
            icon: (meta as { tokenImageUrl?: string }).tokenImageUrl,
            precision,
            protocol: "SPARK",
            layer: "SPARK_SPARK",
            balance: {
              total: owned,
              available,
              pending: 0,
              locked: owned - available,
              totalDisplay: formatAmount(owned, precision),
              availableDisplay: formatAmount(available, precision),
            },
            capabilities: {
              canSend: true,
              canReceive: true,
              canSwap: false,
              supportsLightning: false,
              supportsOnchain: false,
            },
          });
        }
      }

      return assets;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(`Failed to list assets: ${msg}`, "SPARK", "LIST_ASSETS_ERROR", error);
    }
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets();
    const asset = assets.find((a) => a.id === assetId || a.ticker === assetId);

    if (!asset) {
      throw new ProtocolError(`Asset not found: ${assetId}`, "SPARK", "ASSET_NOT_FOUND");
    }

    return asset;
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset["balance"]> {
    const asset = await this.getAsset(assetId);
    return asset.balance;
  }

  async refreshBalances(): Promise<void> {
    // Drop the short-TTL coalescing cache so the next call hits the gateway
    // for a fresh snapshot. The cache only exists to collapse the burst of
    // simultaneous reads from a single dashboard render.
    invalidateSparkBalanceCache();
  }

  // ========================================================================
  // Transaction Operations
  // ========================================================================

  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }

    try {
      const wallet = sparkClientManager.getWallet();
      const limit = Math.max(0, filter?.limit ?? 20);
      const offset = Math.max(0, filter?.offset ?? 0);
      const fetchLimit = offset + limit;
      const requestedAsset = filter?.asset?.trim();
      const createdAfter = filter?.fromTimestamp ? new Date(filter.fromTimestamp) : undefined;
      const createdBefore =
        !createdAfter && filter?.toTimestamp ? new Date(filter.toTimestamp) : undefined;
      const shouldFetchBtc = !requestedAsset || requestedAsset === "BTC";
      const shouldFetchTokens = !requestedAsset || requestedAsset !== "BTC";
      const requestedTokenRawId =
        requestedAsset && requestedAsset !== "BTC"
          ? rawTokenIdFromBech32mTokenId(requestedAsset)
          : "";

      // Best effort: a gateway/auth failure must not hide token activity, nor the
      // offline send-record fallback below. Runs CONCURRENTLY with the token block
      // — they share nothing, and serializing doubled activity latency.
      const btcTxsPromise = (async (): Promise<UnifiedTransaction[]> => {
        if (!shouldFetchBtc) return [];
        try {
          let btcTransfers: SparkTransfer[] = [];
          if (createdAfter || createdBefore) {
            const readonlyClient = await sparkClientManager.getReadonlyClient();
            const sparkAddress = (await wallet.getSparkAddress()) as string;
            const readonlyResult = await readonlyClient.getTransfers({
              sparkAddress,
              limit: fetchLimit,
              offset: 0,
              createdAfter,
              createdBefore,
            });

            const hydratedTransfers = await Promise.all(
              readonlyResult.transfers.map((transfer) => wallet.getTransfer(transfer.id)),
            );

            btcTransfers = hydratedTransfers.filter(
              (transfer): transfer is NonNullable<typeof transfer> => !!transfer,
            ) as SparkTransfer[];
          } else {
            btcTransfers = (await wallet.getTransfers(fetchLimit, 0)).transfers as SparkTransfer[];
          }
          return btcTransfers.map((t) => convertTransferToTransaction(t));
        } catch (err) {
          log.warn("[SparkAdapter] Failed to fetch BTC transfers:", err);
          return [];
        }
      })();

      // Every Spark RPC below is best-effort and isolated: a transport failure must
      // never hide locally-recorded sends, the only reliable record of an outgoing
      // token transfer (a withdrawal with no change output is invisible to the
      // owner-filtered server query).
      const tokenTxsPromise = (async (): Promise<UnifiedTransaction[]> => {
        const tokenTxs: UnifiedTransaction[] = [];
        try {
          if (!shouldFetchTokens) return tokenTxs;
          // Independent prep — address, pubkey, balances (through the shared
          // 3s cache, so a concurrent dashboard render shares the RPC), and
          // the local send outbox all fetch concurrently.
          const [sparkAddress, identityPubKey, balanceSnapshot, allSentRecords] =
            await Promise.all([
              wallet.getSparkAddress() as Promise<string>,
              wallet.getIdentityPublicKey(),
              getSparkBalanceCached(wallet).catch((err) => {
                log.warn("[SparkAdapter] Failed to load token balances for activity:", err);
                return null;
              }),
              loadSentTokenRecords(),
            ]);
          let networkType = "";
          try {
            networkType = getNetworkFromSparkAddress(sparkAddress);
          } catch {
            // Non-fatal — networkType only feeds bech32m encoding fallbacks.
          }

          // Token metadata lookup from current balances — best effort. Empty
          // when the balance is 0 or the balance RPC fails; the converter and
          // the stored-record fallback both tolerate missing metadata.
          const tokenMetaMap = new Map<
            string,
            { name: string; ticker: string; decimals: number }
          >();
          const rawTokenMetaMap = new Map<
            string,
            { id: string; meta: { name: string; ticker: string; decimals: number } }
          >();
          if (balanceSnapshot?.tokenBalances) {
            for (const [tokenId, info] of balanceSnapshot.tokenBalances) {
              const meta = {
                name: info.tokenMetadata.tokenName,
                ticker: info.tokenMetadata.tokenTicker,
                decimals: info.tokenMetadata.decimals,
              };
              tokenMetaMap.set(tokenId, meta);

              const rawTokenIdentifier = (
                info.tokenMetadata as { rawTokenIdentifier?: Uint8Array }
              ).rawTokenIdentifier;
              const rawTokenId = rawTokenIdFromBytes(rawTokenIdentifier);
              if (rawTokenId) {
                rawTokenMetaMap.set(rawTokenId, { id: tokenId, meta });
              }
            }
          }
          const walletSentRecords = allSentRecords.filter(
            (record) => record.senderSparkAddress === sparkAddress,
          );
          const sentRecords =
            requestedAsset && requestedAsset !== "BTC"
              ? walletSentRecords.filter((record) => tokenRefsMatch(record.assetId, requestedAsset))
              : walletSentRecords;
          const sentHashSet = new Set(sentRecords.map((r) => normalizeTxHash(r.hash)));
          const storedRecordMap = new Map<string, SentTokenTxRecord>(
            sentRecords.map((r) => [normalizeTxHash(r.hash), r]),
          );
          const storedAmountMap = new Map<string, bigint>(
            sentRecords.map((r) => [normalizeTxHash(r.hash), BigInt(Math.round(r.amount || 0))]),
          );

          // Owner-keyed `queryTokenTransactions` returns complete output owners and
          // amounts, letting the converter derive direction from output ownership —
          // the protocol exposes no direction field for token transactions.
          const txsWithStatus: Array<{
            tokenTransaction?: unknown;
            status: number;
            tokenTransactionHash: Uint8Array;
          }> = [];
          // The owner-keyed query and the by-hash query (sends without a
          // change output are invisible to the owner filter) are independent
          // server calls — fetch concurrently, dedup afterwards.
          const [ownerResult, sentResult] = await Promise.all([
            wallet
              .queryTokenTransactions({
                ownerPublicKeys: [identityPubKey],
                tokenIdentifiers:
                  requestedAsset && requestedAsset !== "BTC" ? [requestedAsset] : undefined,
                pageSize: fetchLimit,
              })
              .catch((err: unknown) => {
                log.warn("[SparkAdapter] Failed to query token transactions:", err);
                return null;
              }),
            sentRecords.length > 0
              ? wallet
                  .queryTokenTransactionsByTxHashes(
                    sentRecords.map((r) => normalizeTxHash(r.hash)),
                  )
                  .catch((err: unknown) => {
                    log.warn("[SparkAdapter] Failed to fetch sent token transactions:", err);
                    return null;
                  })
              : Promise.resolve(null),
          ]);
          txsWithStatus.push(...(ownerResult?.tokenTransactionsWithStatus ?? []));
          if (sentResult) {
            const existingHashes = new Set(
              txsWithStatus.map((t) => txHashFromBytes(t.tokenTransactionHash)),
            );
            for (const sentTx of sentResult.tokenTransactionsWithStatus ?? []) {
              const hash = txHashFromBytes(sentTx.tokenTransactionHash);
              if (!existingHashes.has(hash)) {
                txsWithStatus.push(sentTx);
              }
            }
          }

          // Convert whatever the gateway returned, tracking which recorded
          // sends were successfully rendered.
          const renderedSendHashes = new Set<string>();
          for (const txWithStatus of txsWithStatus) {
            const converted = convertTokenTransactionToUnified(
              txWithStatus,
              identityPubKey,
              tokenMetaMap,
              rawTokenMetaMap,
              sentHashSet,
              storedRecordMap,
              storedAmountMap,
              networkType,
              requestedAsset && requestedAsset !== "BTC" ? requestedAsset : undefined,
              requestedTokenRawId,
            );
            if (converted) {
              tokenTxs.push(converted);
              const hash = txHashFromBytes(txWithStatus.tokenTransactionHash);
              if (sentHashSet.has(hash)) renderedSendHashes.add(hash);
            }
          }

          // Offline / failed-fetch fallback: synthesize a transaction directly
          // from any recorded send the gateway did not return, so a completed
          // withdrawal always shows up in history.
          let synthesizedCount = 0;
          for (const record of sentRecords) {
            const hash = normalizeTxHash(record.hash);
            if (renderedSendHashes.has(hash)) continue;
            tokenTxs.push(
              buildSentRecordTransaction(
                record,
                requestedAsset && requestedAsset !== "BTC" ? requestedAsset : undefined,
              ),
            );
            synthesizedCount += 1;
          }

          // Diagnostic: surfaces whether the send outbox is populated. If a
          // withdrawal is missing from history and these counts are 0, the
          // send was never recorded (e.g. performed on a pre-outbox build).
          log.info(
            `[SparkAdapter] token activity: ${tokenTxs.length} tx, ` +
              `${allSentRecords.length} stored sends ` +
              `(${sentRecords.length} this wallet, ${renderedSendHashes.size} from gateway, ` +
              `${synthesizedCount} synthesized)`,
          );
        } catch (err) {
          log.warn("[SparkAdapter] Failed to fetch token transactions:", err);
        }
        return tokenTxs;
      })();

      const [btcTxs, tokenTxs] = await Promise.all([btcTxsPromise, tokenTxsPromise]);
      const allTxs = [...btcTxs, ...tokenTxs].sort((a, b) => b.timestamp - a.timestamp);

      const matched = allTxs.filter((tx) => {
        if (!filter) return true;
        if (
          filter.asset &&
          tx.asset?.id !== filter.asset &&
          tx.asset?.ticker !== filter.asset &&
          !tokenRefsMatch(tx.asset?.id, filter.asset)
        )
          return false;
        if (filter.type && tx.type !== filter.type) return false;
        if (filter.status && tx.status !== filter.status) return false;
        if (filter.fromTimestamp && tx.timestamp < filter.fromTimestamp) return false;
        if (filter.toTimestamp && tx.timestamp > filter.toTimestamp) return false;
        return true;
      });

      // Each leg over-fetches the prefix needed for this page. Offset belongs to
      // the sorted union, not to one leg, or interleaved token rows shift pages.
      return matched.slice(offset, offset + limit);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        `Failed to list transactions: ${msg}`,
        "SPARK",
        "LIST_TRANSACTIONS_ERROR",
        error,
      );
    }
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }

    try {
      const wallet = sparkClientManager.getWallet();
      const transfer = (await wallet.getTransfer(txId)) as SparkTransfer | undefined;

      if (!transfer) {
        throw new ProtocolError(`Transaction not found: ${txId}`, "SPARK", "TX_NOT_FOUND");
      }

      return convertTransferToTransaction(transfer);
    } catch (error: unknown) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(`Transaction not found: ${txId}`, "SPARK", "TX_NOT_FOUND", error);
    }
  }

  // ========================================================================
  // Payment Operations
  // ========================================================================

  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }

    if (request.asset && request.asset !== "BTC") {
      throw new ProtocolError("Spark only supports BTC invoices", "SPARK", "UNSUPPORTED_ASSET");
    }

    try {
      const wallet = sparkClientManager.getWallet();
      const result = await wallet.createLightningInvoice({
        amountSats: request.amount ?? 0,
        memo: request.description,
        expirySeconds: request.expirySeconds,
      });

      const inv = result.invoice;
      const encodedInvoice = inv.encodedInvoice;

      // Store request ID for invoice status polling
      if (result.id && encodedInvoice) {
        this.invoiceRequestIds.set(encodedInvoice, result.id);
      }

      const expiresAt = parseSdkExpiryMs(inv.expiresAt);
      return {
        invoice: encodedInvoice,
        paymentHash: inv.paymentHash ?? "",
        amount: request.amount,
        expiresAt: expiresAt ?? Date.now() + (request.expirySeconds ?? 3600) * 1000,
        description: request.description,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        `Failed to create invoice: ${msg}`,
        "SPARK",
        "CREATE_INVOICE_ERROR",
        error,
      );
    }
  }

  async createSparkInvoice(request: InvoiceRequest): Promise<Invoice> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }

    try {
      const wallet = sparkClientManager.getWallet();
      const invoice = await wallet.createSatsInvoice({
        amount: request.amount || undefined,
        memo: request.description,
        expiryTime: request.expirySeconds
          ? new Date(Date.now() + request.expirySeconds * 1000)
          : undefined,
      });

      return {
        invoice: invoice as string,
        paymentHash: "",
        amount: request.amount,
        expiresAt: Date.now() + (request.expirySeconds ?? 3600) * 1000,
        description: request.description,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        `Failed to create Spark invoice: ${msg}`,
        "SPARK",
        "CREATE_SPARK_INVOICE_ERROR",
        error,
      );
    }
  }

  async decodeInvoice(input: string): Promise<DecodedInvoice> {
    // Detect payment type without SDK parse() — bolt11 starts with "ln"
    const lower = input.trim().toLowerCase();

    if (lower.startsWith("ln")) {
      // bolt11 invoice. `decodeBolt11` is already imported and used in this file
      // (sendPayment), and it reads the amount out of the HRP — so returning no
      // amount here silently defeated the pre-flight "verify what you're paying"
      // step on a protocol that declares `lightning-send`. The payment hash is
      // deliberately still empty: bolt11.ts states the full field decode
      // (payment_hash, description) is left to node-side decoders.
      const { amountSat, amountMsat } = decodeBolt11(input.trim());
      return {
        paymentHash: "",
        amount: amountSat,
        amountMsat,
        expiresAt: 0,
        destination: input,
      };
    }

    // Spark address or BTC address
    return {
      paymentHash: "",
      expiresAt: 0,
      destination: input,
    };
  }

  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }

    try {
      const wallet = sparkClientManager.getWallet();
      const destination = request.invoice.trim();
      const lower = destination.toLowerCase();

      if (lower.startsWith("ln")) {
        // payLightningInvoice only DISPATCHES to the SSP; settlement is async and
        // can still fail. Reporting 'confirmed' on dispatch made WebLN/NWC callers
        // believe zaps succeeded when they never settled, and denied them the
        // preimage NIP-47 requires — so poll until a terminal state.
        const extReq = request as PaymentRequest & { maxFee?: number };
        // Amountless ("0-sat") BOLT-11 invoices require `amountSatsToSend`
        // explicitly, and it is rejected on amount-bearing ones — so gate on the
        // invoice, not on whether the caller supplied an amount.
        const decodedInvoice = decodeBolt11(destination);
        const invoiceIsAmountless = decodedInvoice.amountMsat == null;
        const result = await wallet.payLightningInvoice({
          invoice: destination,
          maxFeeSats: extReq.maxFee ?? DEFAULT_MAX_FEE_SATS,
          ...(invoiceIsAmountless && request.amount && request.amount > 0
            ? { amountSatsToSend: request.amount }
            : {}),
        } as Parameters<typeof wallet.payLightningInvoice>[0]);
        const lnResult = result as unknown as Record<string, unknown>;

        const id = result.id;
        const amountSats = Number(decodedInvoice.amountSat ?? request.amount ?? 0);
        const timestamp = parseSdkExpiryMs(result.createdAt) ?? Date.now();

        const settlement = await waitForLightningSendSettlement(wallet, id, lnResult);
        if (settlement.status === "failed") {
          throw new ProtocolError(
            `Lightning payment failed (${settlement.rawStatus})`,
            "SPARK",
            "LIGHTNING_PAYMENT_FAILED",
          );
        }

        return {
          paymentHash: id,
          preimage: settlement.preimage,
          amount: amountSats,
          fee: settlement.feeSats,
          status: settlement.status,
          timestamp,
        };
      }

      // Spark address or Spark invoice
      if (isValidSparkAddress(destination)) {
        // Distinguish a plain Spark address from a Spark invoice by checking for sparkInvoiceFields
        const network = getNetworkFromSparkAddress(destination);
        const decoded = decodeSparkAddress(destination, network);

        if (decoded.sparkInvoiceFields) {
          // Spark invoice — use fulfillSparkInvoice
          const response = await wallet.fulfillSparkInvoice([
            {
              invoice: destination as SparkAddressFormat,
              amount: request.amount ? BigInt(request.amount) : undefined,
            },
          ]);

          if (response.satsTransactionErrors.length > 0) {
            throw new Error(response.satsTransactionErrors[0].error.message);
          }

          const success = response.satsTransactionSuccess[0];
          if (!success) {
            throw new Error("Spark invoice payment returned no result");
          }

          const transfer = success.transferResponse as SparkTransfer;
          return {
            paymentHash: transfer.id,
            amount: transfer.totalValue,
            fee: 0,
            status: mapTransferStatus(transfer.status),
            timestamp: transfer.createdTime?.getTime() ?? Date.now(),
          };
        }

        // Plain Spark address — use transfer
        const transfer = (await wallet.transfer({
          receiverSparkAddress: destination,
          amountSats: request.amount ?? 0,
        })) as SparkTransfer;

        return {
          paymentHash: transfer.id,
          amount: transfer.totalValue,
          fee: 0,
          status: mapTransferStatus(transfer.status),
          timestamp: transfer.createdTime?.getTime() ?? Date.now(),
        };
      }

      // On-chain BTC withdrawal — requires a fee quote first
      const feeQuote: CoopExitFeeQuote | null = await wallet.getWithdrawalFeeQuote({
        amountSats: request.amount ?? 0,
        withdrawalAddress: destination,
      });
      if (!feeQuote) {
        throw new Error("Failed to get withdrawal fee quote for on-chain exit");
      }
      const feeAmountSats =
        (feeQuote.l1BroadcastFeeMedium?.originalValue ?? 0) +
        (feeQuote.userFeeMedium?.originalValue ?? 0);
      const result = await wallet.withdraw({
        onchainAddress: destination,
        amountSats: request.amount ?? 0,
        exitSpeed: ExitSpeed.MEDIUM,
        feeQuoteId: feeQuote.id,
        feeAmountSats,
      });

      return {
        paymentHash: result?.id ?? "",
        amount: request.amount ?? 0,
        fee: result?.fee?.originalValue ?? 0,
        status: "pending" as const,
        timestamp: Date.now(),
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        `Failed to send payment: ${msg}`,
        "SPARK",
        "SEND_PAYMENT_ERROR",
        error,
      );
    } finally {
      // Any send attempt (success OR failure) makes the cached balance stale;
      // failures may still have produced a partial state change on the gateway.
      invalidateSparkBalanceCache();
    }
  }

  async getPaymentStatus(paymentId: string): Promise<PaymentStatus> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }

    try {
      const wallet = sparkClientManager.getWallet();

      // The Spark SDK may return entity IDs like "SparkLightningSendRequest:uuid"
      // but getTransfer expects a plain UUID.
      const transferId = paymentId.includes(":") ? paymentId.split(":").pop()! : paymentId;
      const transfer = (await wallet.getTransfer(transferId)) as SparkTransfer | undefined;

      if (!transfer) {
        throw new ProtocolError(`Payment not found: ${paymentId}`, "SPARK", "PAYMENT_STATUS_ERROR");
      }

      return {
        paymentHash: paymentId,
        status: mapTransferStatus(transfer.status),
        amount: transfer.totalValue,
        timestamp: transfer.createdTime?.getTime() ?? 0,
      };
    } catch (error: unknown) {
      if (error instanceof ProtocolError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        `Failed to get payment status: ${msg}`,
        "SPARK",
        "PAYMENT_STATUS_ERROR",
        error,
      );
    }
  }

  // ========================================================================
  // Address Operations
  // ========================================================================

  async getReceiveAddress(assetId?: string): Promise<Address> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }

    try {
      const wallet = sparkClientManager.getWallet();

      // Spark-to-Spark native address
      if (assetId === "SPARK") {
        const address = await wallet.getSparkAddress();
        return {
          address: address as string,
          format: "SPARK_ADDRESS",
          asset: "BTC",
        };
      }

      // BTC on-chain deposit address
      if (!assetId || assetId === "BTC" || assetId.toLowerCase() === "btc") {
        const address = await wallet.getSingleUseDepositAddress();
        return {
          address,
          format: "BTC_ADDRESS",
          asset: "BTC",
        };
      }

      throw new ProtocolError("Spark only supports BTC", "SPARK", "UNSUPPORTED_ASSET");
    } catch (error: unknown) {
      if (error instanceof ProtocolError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        `Failed to get receive address: ${msg}`,
        "SPARK",
        "GET_ADDRESS_ERROR",
        error,
      );
    }
  }

  async claimSparkL1Deposit(params: {
    address: string;
  }): Promise<{ status: "awaiting" | "claimed" | "error"; txids?: string[]; error?: string }> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }
    const address = params.address?.trim();
    if (!address) {
      return { status: "error", error: "address is required" };
    }
    const wallet = sparkClientManager.getWallet();

    let utxos: Array<{ txid: string; vout: number }>;
    try {
      utxos = await wallet.getUtxosForDepositAddress(address, 10, 0, true);
    } catch (error: unknown) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : "utxo lookup failed",
      };
    }
    if (!utxos || utxos.length === 0) return { status: "awaiting" };

    const claimedTxids: string[] = [];
    let lastError: string | undefined;
    for (const utxo of utxos) {
      try {
        await wallet.claimDeposit(utxo.txid);
        claimedTxids.push(utxo.txid);
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (claimedTxids.length === 0) {
      return { status: "error", error: lastError ?? "no utxos claimed" };
    }
    return { status: "claimed", txids: claimedTxids };
  }

  /**
   * Sweep every previously-generated single-use deposit address still unclaimed and
   * credit confirmed UTXOs paid to them. Each `getSingleUseDepositAddress()` call
   * returns a NEW address, so a deposit to an earlier session's address would
   * otherwise stay stranded — the deposit-screen poller only watches the current
   * one. Run on unlock and when the deposit screen opens.
   */
  async sweepSparkL1Deposits(): Promise<{
    addressesChecked: number;
    claimedTxids: string[];
    errors: string[];
  }> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }
    const wallet = sparkClientManager.getWallet();

    let unused: string[];
    try {
      unused = await wallet.getUnusedDepositAddresses();
    } catch (error: unknown) {
      return {
        addressesChecked: 0,
        claimedTxids: [],
        errors: [error instanceof Error ? error.message : "getUnusedDepositAddresses failed"],
      };
    }
    if (!unused || unused.length === 0) {
      return { addressesChecked: 0, claimedTxids: [], errors: [] };
    }

    const claimedTxids: string[] = [];
    const errors: string[] = [];
    for (const addr of unused) {
      try {
        const utxos = await wallet.getUtxosForDepositAddress(addr, 10, 0, true);
        if (!utxos || utxos.length === 0) continue;
        for (const utxo of utxos) {
          try {
            await wallet.claimDeposit(utxo.txid);
            claimedTxids.push(utxo.txid);
          } catch (claimErr: unknown) {
            errors.push(claimErr instanceof Error ? claimErr.message : String(claimErr));
          }
        }
      } catch (lookupErr: unknown) {
        errors.push(lookupErr instanceof Error ? lookupErr.message : String(lookupErr));
      }
    }

    return { addressesChecked: unused.length, claimedTxids, errors };
  }

  // ========================================================================
  // Node & Balance Operations
  // ========================================================================

  async getNodeInfo(): Promise<NodeInfo> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }
    try {
      const wallet = sparkClientManager.getWallet();
      const { balance } = await getSparkBalanceCached(wallet);
      const balanceSats = Number(balance);
      return {
        channelsBalanceMsat: balanceSats * 1000,
        maxPayableMsat: balanceSats * 1000,
        onchainBalanceMsat: 0,
        pendingOnchainBalanceMsat: 0,
        maxReceivableMsat: 0,
        inboundLiquidityMsats: 0,
        connectedPeers: [],
        utxos: 0,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(`Failed to get node info: ${msg}`, "SPARK", "NODE_INFO_ERROR", error);
    }
  }

  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }
    try {
      const wallet = sparkClientManager.getWallet();
      const { balance } = await getSparkBalanceCached(wallet);
      const balanceSats = Number(balance);
      return {
        confirmed: balanceSats,
        unconfirmed: 0,
        total: balanceSats,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(`Failed to get BTC balance: ${msg}`, "SPARK", "BALANCE_ERROR", error);
    }
  }

  async listChannels(): Promise<[]> {
    // Spark doesn't have traditional Lightning channels
    return [];
  }

  async listPayments(): Promise<{ transfers?: SparkTransfer[] }> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }
    try {
      const wallet = sparkClientManager.getWallet();
      const { transfers } = (await withTimeout(
        wallet.getTransfers(),
        SPARK_RPC_TIMEOUT_MS,
        "spark.getTransfers",
      )) as { transfers?: SparkTransfer[] };
      return { transfers: transfers as SparkTransfer[] };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        `Failed to list payments: ${msg}`,
        "SPARK",
        "LIST_PAYMENTS_ERROR",
        error,
      );
    }
  }

  async listTransfers(_options?: { asset_id?: string }): Promise<{ transfers: [] }> {
    // Spark doesn't have RGB-style transfers
    return { transfers: [] };
  }

  async sendBtcOnchain(params: {
    address: string;
    amount: number;
    feeRate?: number;
  }): Promise<Record<string, unknown>> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }
    try {
      const wallet = sparkClientManager.getWallet();

      // Step 1: Get fee quote — required by the SDK for cooperative exit
      const feeQuote: CoopExitFeeQuote | null = await wallet.getWithdrawalFeeQuote({
        amountSats: params.amount,
        withdrawalAddress: params.address,
      });
      if (!feeQuote) {
        throw new Error("Failed to get withdrawal fee quote");
      }

      // Step 2: Execute withdrawal with the fee quote
      const feeAmountSats =
        (feeQuote.l1BroadcastFeeMedium?.originalValue ?? 0) +
        (feeQuote.userFeeMedium?.originalValue ?? 0);
      const result = await wallet.withdraw({
        onchainAddress: params.address,
        amountSats: params.amount,
        exitSpeed: ExitSpeed.MEDIUM,
        feeQuoteId: feeQuote.id,
        feeAmountSats,
      });
      return result as unknown as Record<string, unknown>;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        `Failed to send BTC on-chain: ${msg}`,
        "SPARK",
        "SEND_BTC_ERROR",
        error,
      );
    } finally {
      invalidateSparkBalanceCache();
    }
  }

  // ========================================================================
  // PSBT Signing
  // ========================================================================

  async signPsbt(psbtHex: string): Promise<{ psbt: string; unchanged: boolean }> {
    // A locked wallet must not be able to keep signing — the invariant
    // BaseWdkAdapter states for the WDK family (BaseWdkAdapter.ts:30-33) and
    // commit fb826c9 (H1) applies engine-wide. Holding a mnemonic is not the
    // same as being connected.
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }
    if (!this.config?.mnemonic) {
      throw new ProtocolError("Wallet mnemonic not available", "SPARK", "NOT_CONNECTED");
    }
    const { signPsbt: doSign } = await import("../lib/psbt-signer");
    const result = doSign(psbtHex, this.config.mnemonic);
    return { psbt: result.psbt, unchanged: result.unchanged };
  }

  // ========================================================================
  // Message Signing
  // ========================================================================

  async signMessage(message: string): Promise<string> {
    // Same invariant as signPsbt: never sign for a wallet the host has locked.
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }
    if (!this.config?.mnemonic) {
      throw new ProtocolError("Wallet mnemonic not available", "SPARK", "NOT_CONNECTED");
    }
    const seed = resolveWalletSeed(this.config.mnemonic);
    const root = HDKey.fromMasterSeed(seed);
    // m/138'/1 — wallet-identity message-signing key, distinct from the
    // LNURL-auth hashing key at m/138'/0.
    const node = root.derive("m/138'/1");
    if (!node.privateKey) {
      throw new ProtocolError(
        "Failed to derive message-signing key",
        "SPARK",
        "KEY_DERIVATION_ERROR",
      );
    }
    return signLnMessage(message, node.privateKey);
  }

  async verifyMessage(message: string, signature: string): Promise<string> {
    return verifyLnMessage(message, signature);
  }

  // ========================================================================
  // RGB-Specific Operations (Not supported by Spark)
  // ========================================================================

  async createRgbInvoice(_params: unknown): Promise<never> {
    throw new ProtocolError("RGB invoices not supported by Spark", "SPARK", "NOT_SUPPORTED");
  }

  async decodeRgbInvoice(_params: unknown): Promise<never> {
    throw new ProtocolError(
      "RGB invoice decoding not supported by Spark",
      "SPARK",
      "NOT_SUPPORTED",
    );
  }

  async getInvoiceStatus(params: { invoice: string }): Promise<{ status: string }> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }

    const requestId = this.invoiceRequestIds.get(params.invoice);
    if (!requestId) {
      // Invoice not tracked — might be from a previous session
      return { status: "Pending" };
    }

    try {
      const wallet = sparkClientManager.getWallet();
      const request = await wallet.getLightningReceiveRequest(requestId);

      if (!request) {
        return { status: "Pending" };
      }

      // Map LightningReceiveRequestStatus to simple status
      const s = request.status;
      if (
        s === "LIGHTNING_PAYMENT_RECEIVED" ||
        s === "TRANSFER_COMPLETED" ||
        s === "PAYMENT_PREIMAGE_RECOVERED"
      ) {
        // Clean up tracked invoice on terminal state
        this.invoiceRequestIds.delete(params.invoice);
        return { status: "Succeeded" };
      }
      if (
        s === "TRANSFER_FAILED" ||
        s === "TRANSFER_CREATION_FAILED" ||
        s === "REFUND_SIGNING_COMMITMENTS_QUERYING_FAILED" ||
        s === "REFUND_SIGNING_FAILED" ||
        s === "PAYMENT_PREIMAGE_RECOVERING_FAILED"
      ) {
        this.invoiceRequestIds.delete(params.invoice);
        return { status: "Failed" };
      }
      // INVOICE_CREATED, TRANSFER_CREATED, etc.
      return { status: "Pending" };
    } catch (error: unknown) {
      // A lookup that FAILED is not a Pending payment. Mapping the gateway's error
      // to `Pending` made a receive-flow poll wait forever on an invoice whose
      // status could not be read, and the host could never distinguish "not paid
      // yet" from "we could not check" — so it could neither retry nor warn.
      // Both RGB siblings propagate here (`RgbAdapter`/`RlnWdkAdapter`
      // getInvoiceStatus), and this adapter's `sendPayment` already throws.
      // `Pending` stays for the genuinely-unknown-but-answered cases above
      // (untracked invoice, no request row) (audit finding G-F3).
      const msg = error instanceof Error ? error.message : String(error);
      log.warn("[SparkAdapter] Invoice status check failed:", msg);
      throw new ProtocolError(
        `Failed to check invoice status: ${msg}`,
        "SPARK",
        "INVOICE_STATUS_ERROR",
        error instanceof Error ? error : undefined,
      );
    }
  }

  async sendAsset(params: {
    assetId: string;
    amount: number;
    recipientId: string;
    assignment?: { type: string; value: number } | null;
    transportEndpoints?: string[];
    feeRate?: number;
    donation?: boolean;
    witness_data?: unknown;
  }): Promise<Record<string, unknown>> {
    if (!this.isConnected()) {
      throw new ProtocolError("Not connected", "SPARK", "NOT_CONNECTED");
    }

    try {
      const wallet = sparkClientManager.getWallet();
      const senderSparkAddress = (await wallet.getSparkAddress()) as string;
      const assignmentAmount = params.assignment?.value;
      const tokenAmount =
        typeof assignmentAmount === "number" && assignmentAmount > 0
          ? assignmentAmount
          : params.amount;
      if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
        throw new Error("Spark token amount must be greater than 0");
      }
      const destination = params.recipientId.trim();

      // Resolve token metadata for the sent-record (cached balance is warm from the send UI)
      let sentMeta = { ticker: "TOKEN", name: params.assetId, decimals: 0 };
      try {
        const { tokenBalances } = await getSparkBalanceCached(wallet);
        const info = tokenBalances?.get(params.assetId as Bech32mTokenIdentifier);
        if (info) {
          sentMeta = {
            ticker: info.tokenMetadata.tokenTicker,
            name: info.tokenMetadata.tokenName,
            decimals: info.tokenMetadata.decimals,
          };
        }
      } catch {
        // Non-critical — falls back to tokenMetaMap in listTransactions
      }

      // Check if the destination is a Spark invoice (contains sparkInvoiceFields)
      if (isValidSparkAddress(destination)) {
        const network = getNetworkFromSparkAddress(destination);
        const decoded = decodeSparkAddress(destination, network);

        if (decoded.sparkInvoiceFields) {
          // Spark token invoice — use fulfillSparkInvoice
          const response = await wallet.fulfillSparkInvoice([
            {
              invoice: destination as SparkAddressFormat,
              amount: BigInt(tokenAmount),
            },
          ]);

          if (response.tokenTransactionErrors.length > 0) {
            throw new Error(response.tokenTransactionErrors[0].error.message);
          }
          if (response.invalidInvoices.length > 0) {
            throw new Error(response.invalidInvoices[0].error.message);
          }

          const success = response.tokenTransactionSuccess[0];
          if (success) {
            await saveSentTokenRecord({
              hash: success.txid,
              senderSparkAddress,
              amount: tokenAmount,
              assetId: params.assetId,
              ...sentMeta,
              timestamp: Date.now(),
            });
            return { txId: success.txid };
          }

          // NO sats-leg fallback. This entry point is `sendAsset` — the caller asked
          // to move a TOKEN. An empty `tokenTransactionSuccess` means the token leg
          // did NOT succeed, so returning `satsTransactionSuccess[0]`'s id told the
          // caller "your token send succeeded, here is its id" while handing them
          // the id of a different, BTC transfer — and it skipped the
          // `saveSentTokenRecord` call above, the only reliable record of an
          // outgoing token transfer, so the send was invisible in history too.
          //
          // The old comment read "maybe it was a sats invoice bundled with token".
          // For a genuinely bundled invoice BOTH legs succeed, so `success` above is
          // present and this path never runs. What the fallback actually covered was
          // a sats-ONLY invoice reached through `sendAsset` — where
          // `fulfillSparkInvoice` was handed `amount: BigInt(tokenAmount)` and would
          // settle that many SATS instead of that many units of the asset. Reporting
          // that as a successful asset send is worse than failing
          // (audit finding G-F5).
          throw new ProtocolError(
            "Spark invoice payment returned no token transfer result",
            "SPARK",
            "SEND_ASSET_ERROR",
          );
        }
      }

      // Plain Spark address — use transferTokens
      const txId = await wallet.transferTokens({
        tokenIdentifier: params.assetId as Bech32mTokenIdentifier,
        tokenAmount: BigInt(tokenAmount),
        receiverSparkAddress: destination,
      });

      await saveSentTokenRecord({
        hash: txId,
        senderSparkAddress,
        amount: tokenAmount,
        assetId: params.assetId,
        ...sentMeta,
        timestamp: Date.now(),
      });
      return { txId };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProtocolError(
        `Failed to send Spark token: ${msg}`,
        "SPARK",
        "SEND_ASSET_ERROR",
        error,
      );
    }
  }

  // ========================================================================
  // Swap Operations (Not supported by Spark)
  // ========================================================================

  supportsSwaps(): boolean {
    return false;
  }

  async getSwapQuote(_request: QuoteRequest): Promise<Quote> {
    throw new ProtocolError("Swap operations not supported by Spark", "SPARK", "NOT_SUPPORTED");
  }

  async executeSwap(_quote: Quote): Promise<SwapResult> {
    throw new ProtocolError("Swap operations not supported by Spark", "SPARK", "NOT_SUPPORTED");
  }

  async getSwapStatus(_swapId: string): Promise<SwapResult> {
    throw new ProtocolError("Swap operations not supported by Spark", "SPARK", "NOT_SUPPORTED");
  }

  // --- Helper methods -----------------------------------------------------
  // Pure helpers live in ./helpers.ts; SDK↔unified converters in ./converters.ts.
}
