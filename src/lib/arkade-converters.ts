/**
 * SDK ↔ unified-shape converter for the Arkade adapter.
 *
 * The single converter here covers Arkade transaction history:
 *  - `convertArkTxToUnifiedAll` — expand one ArkTransaction into one
 *    UnifiedTransaction per asset moved (or a single BTC entry for
 *    pure-BTC transfers).
 *
 * `getAssetDetails` is injected as a callback so this module stays pure —
 * the adapter wraps its `getCachedAssetDetails(wallet, …)` to pre-bind the
 * wallet + cache. That keeps the unit tests free of the @arkade-os/sdk
 * Wallet shape.
 */

import type { ArkTransaction, Asset as ArkAsset } from "@arkade-os/sdk";
import type { UnifiedAsset, UnifiedTransaction } from "../types/base";
import {
  formatSats,
  formatUnits,
  getAssetMetadata,
  getAssetName,
  getAssetPrecision,
  getAssetTicker,
  toNumber,
  toStringValue,
} from "./arkade-helpers";

/**
 * Resolve metadata for an Arkade asset id. The adapter passes a
 * cache-backed implementation that calls `wallet.assetManager.getAssetDetails`.
 * Returning `null` on failure is fine — the converter falls back to the
 * helper-derived ticker / name / precision.
 */
export type AssetDetailsResolver = (assetId: string) => Promise<Record<string, unknown> | null>;

/**
 * Expand an ArkTransaction into one UnifiedTransaction per asset moved.
 * Asset-bearing transfers carry only dust BTC for the carrier output, so we
 * emit one entry per `tx.assets[]` entry; pure-BTC transfers emit a single
 * BTC entry. `type` is the SDK's TxType enum: "SENT" or "RECEIVED".
 *
 * SDK semantics (transactionHistory.js): asset amounts on RECEIVED txs come
 * from `collectAssets` (positive sums). Asset amounts on SENT txs come from
 * `subtractAssets(spent, change)` — i.e. `change - spent`, which is negative.
 * We surface absolute amounts and rely on `direction` for the sign.
 *
 * On any error the converter swallows and returns `[]` — `listTransactions`
 * uses Promise.all over a flat-map, so a single malformed history entry
 * must not poison the whole batch.
 */
export async function convertArkTxToUnifiedAll(
  tx: ArkTransaction,
  resolveDetails: AssetDetailsResolver,
): Promise<UnifiedTransaction[]> {
  try {
    const isSend = tx.type === "SENT";
    const amountSats: number = tx.amount ?? 0;
    const timestamp: number = tx.createdAt || Date.now();

    const baseTxId =
      tx.key?.arkTxid || tx.key?.commitmentTxid || tx.key?.boardingTxid || `ark-${timestamp}`;

    // Arkade's reference wallet treats all SENT history rows as settled while
    // preserving unsettled RECEIVED rows as preconfirmed/pending.
    const status: "confirmed" | "pending" = isSend || tx.settled ? "confirmed" : "pending";
    const direction: "send" | "receive" = isSend ? "send" : "receive";

    const assetEntries: Array<{ assetId: string; amount: number }> = Array.isArray(tx.assets)
      ? tx.assets
          .map((a: ArkAsset) => ({
            assetId: toStringValue(a?.assetId),
            amount: Math.abs(toNumber(a?.amount)),
          }))
          .filter((a: { assetId: string; amount: number }) => a.assetId && a.amount > 0)
      : [];

    if (assetEntries.length > 0) {
      // AssetId format: hex(txid_bytes, 32) + hex(uint16LE(groupIndex), 2)
      // For group 0 the last 4 chars are "0000", so an issuance has assetId === arkTxid + "0000".
      const arkTxid = toStringValue(tx.key?.arkTxid ?? "").toLowerCase();

      return await Promise.all(
        assetEntries.map(async ({ assetId, amount }) => {
          const details = await resolveDetails(assetId);
          const metadata = getAssetMetadata(details);
          const precision = getAssetPrecision(metadata);
          const ticker = getAssetTicker(assetId, metadata);
          const name = getAssetName(assetId, ticker, metadata);
          const icon = typeof metadata?.icon === "string" ? metadata.icon : undefined;

          const isIssuance =
            isSend && arkTxid.length === 64 && assetId.toLowerCase() === arkTxid + "0000";

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
          };

          return {
            id: `${baseTxId}-${assetId}`,
            type: direction,
            status,
            timestamp,
            amount,
            amountDisplay: formatUnits(amount, precision),
            fee: 0,
            feeDisplay: "0.00000000",
            asset,
            protocolData: {
              type: tx.type,
              settled: tx.settled,
              key: tx.key,
              btcAmountSats: amountSats,
              isIssuance,
            },
          } satisfies UnifiedTransaction;
        }),
      );
    }

    const btcAsset: UnifiedAsset = {
      id: "BTC",
      name: "Bitcoin (Ark)",
      ticker: "BTC",
      precision: 8,
      protocol: "ARKADE",
      layer: "ARKADE_ARKADE",
      balance: {
        total: amountSats,
        available: amountSats,
        pending: 0,
        totalDisplay: formatSats(amountSats),
        availableDisplay: formatSats(amountSats),
      },
      capabilities: {
        canSend: true,
        canReceive: true,
        canSwap: false,
        supportsLightning: false,
        supportsOnchain: true,
      },
    };

    return [
      {
        id: baseTxId,
        type: direction,
        status,
        timestamp,
        amount: amountSats,
        amountDisplay: formatSats(amountSats),
        fee: 0,
        feeDisplay: "0.00000000",
        asset: btcAsset,
        protocolData: {
          type: tx.type,
          settled: tx.settled,
          key: tx.key,
        },
      },
    ];
  } catch {
    return [];
  }
}
