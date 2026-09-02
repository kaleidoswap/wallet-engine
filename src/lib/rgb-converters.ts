/**
 * SDK ↔ unified-shape converters for the RGB adapter. Every function is
 * side-effect free, has no `this` dependencies, and imports types only.
 */

import type { AssetBalanceResponse, BtcBalanceResponse } from "kaleido-sdk/rln";
import type { UnifiedAsset, UnifiedTransaction } from "../types/base";
import { roundedMsatToSat, toSafeAmountNumber } from "../lightning/amounts";
import {
  formatAmount,
  mapPaymentStatus,
  mapSwapStatus,
  mapTransferStatus,
  mapTransferType,
} from "./rgb-helpers";

// ── Balance shape converters ──────────────────────────────────────────────
// Three upstream shapes project into `UnifiedAsset["balance"]`. Each converter is
// the only place that knows its SDK response's field names.

/**
 * `wallet.getBtcBalance()` splits BTC into vanilla and colored (RGB-allocated)
 * sub-balances. Only the vanilla portion is the BTC asset's balance. A colored sat
 * carries an RGB allocation; spending it as ordinary BTC destroys that asset, so
 * colored sats are exposed only through the RGB balance views.
 */
export function convertBtcBalance(btcBalance: BtcBalanceResponse): UnifiedAsset["balance"] {
  const vanilla = btcBalance.vanilla ?? { settled: 0, future: 0, spendable: 0 };
  // `future` is owned after settlement; pending is only its unsettled delta.
  const spendable = vanilla.spendable || 0;
  const settled = vanilla.settled || 0;
  const future = vanilla.future || 0;
  const owned = vanilla.future ?? vanilla.settled ?? vanilla.spendable ?? 0;
  return {
    total: owned,
    available: spendable,
    pending: Math.max(0, future - settled),
    totalDisplay: formatAmount(owned, 8),
    availableDisplay: formatAmount(spendable, 8),
  };
}

/**
 * `wallet.getAssetBalance(assetId)`: exposes the off-chain inbound/outbound
 * capacities for the channel-aware breakdown, and treats `offchain_outbound` as
 * `locked` for legacy callers unaware of the off-chain split.
 */
export function convertSdkBalance(
  balance: AssetBalanceResponse,
  precision: number = 8,
): UnifiedAsset["balance"] {
  // Match RgbCore: total is projected ownership, pending is the unsettled delta.
  const settled = balance.settled || 0;
  const spendable = balance.spendable || 0;
  const future = balance.future || 0;
  const owned = balance.future ?? balance.settled ?? balance.spendable ?? 0;
  return {
    total: owned,
    available: spendable,
    pending: Math.max(0, future - settled),
    locked: balance.offchain_outbound || 0,
    offchain_outbound: balance.offchain_outbound || 0,
    offchain_inbound: balance.offchain_inbound || 0,
    totalDisplay: formatAmount(owned, precision),
    availableDisplay: formatAmount(spendable, precision),
  } as UnifiedAsset["balance"];
}

/**
 * `client.rln.listAssets()` returns balance as a flat, `undefined`-safe
 * `Record<string, number>`. Same projection as `convertSdkBalance` without the
 * required-field assumptions.
 */
export function convertNodeBalance(
  balance: Record<string, number> | undefined,
  precision: number = 8,
): UnifiedAsset["balance"] {
  // Same semantics as `convertSdkBalance` above / `RgbCore.rgbAssetBalance`.
  const settled = balance?.settled || 0;
  const available = balance?.spendable || 0;
  const future = balance?.future || 0;
  const total = balance?.future ?? balance?.settled ?? balance?.spendable ?? 0;
  const pending = Math.max(0, future - settled);

  return {
    total,
    available,
    pending,
    locked: balance?.offchain_outbound || 0,
    offchain_outbound: balance?.offchain_outbound || 0,
    offchain_inbound: balance?.offchain_inbound || 0,
    totalDisplay: formatAmount(total, precision),
    availableDisplay: formatAmount(available, precision),
  } as UnifiedAsset["balance"];
}

// ── Asset converter ──────────────────────────────────────────────────────

/**
 * Build a `UnifiedAsset` from the raw `client.rln.listAssets()` payload. Precision
 * defaults to 8 when the node omits it — pre-RGB20 assets sometimes do.
 */
export function convertNodeAssetToUnified(asset: Record<string, unknown>): UnifiedAsset {
  const precision = (asset.precision as number) ?? 8;
  return {
    id: asset.asset_id as string,
    name: asset.name as string,
    ticker: asset.ticker as string,
    precision,
    protocol: "RGB_LN",
    layer: "RGB_LN",
    balance: convertNodeBalance(asset.balance as Record<string, number> | undefined, precision),
    capabilities: {
      canSend: true,
      canReceive: true,
      canSwap: false,
      supportsLightning: true,
      supportsOnchain: true,
    },
  };
}

// ── Transaction converters ───────────────────────────────────────────────
// On-chain transfers, lightning payments and maker/taker swaps all project into
// `UnifiedTransaction`, so the activity view need not switch on protocol.

/**
 * On-chain RGB transfer from `client.rln.listTransfers()`. `asset` is left empty;
 * the caller joins on `asset_id` against the asset inventory.
 *
 * @param precision Display precision of the transferred asset; defaults to 8.
 */
export function convertTransferToTransaction(
  transfer: Record<string, unknown>,
  precision: number = 8,
): UnifiedTransaction {
  return {
    id: (transfer.txid as string) || `tx_${Date.now()}`,
    type: mapTransferType(transfer.kind as string | undefined),
    status: mapTransferStatus(transfer.status as string | undefined),
    // The SDK uses Unix seconds; the engine contract uses milliseconds.
    timestamp: transfer.created_at ? (transfer.created_at as number) * 1000 : Date.now(),
    amount: (transfer.amount as number) || 0,
    // ASSET base units → the asset's own precision. `fee` below stays at 8: it
    // is the on-chain miner fee, denominated in sats regardless of the asset.
    amountDisplay: formatAmount((transfer.amount as number) || 0, precision),
    fee: transfer.fee as number | undefined,
    feeDisplay: formatAmount((transfer.fee as number) || 0, 8),
    asset: {} as UnifiedAsset, // Would need to be populated
    from: transfer.sender as string | undefined,
    to: transfer.recipient as string | undefined,
    protocolData: transfer,
  };
}

/**
 * Maker/taker swap from `client.rln.listSwaps()`. The same swap appears once per
 * side, so `side` distinguishes them in the rendered id. Timestamp prefers
 * `completed_at`, then `initiated_at`, then `requested_at` (seconds → ms).
 *
 * @param precision Display precision of the swap's from asset; defaults to 8.
 */
export function convertSwapToTransaction(
  swap: Record<string, unknown>,
  side: "maker" | "taker",
  precision: number = 8,
): UnifiedTransaction {
  const paymentHash = (swap.payment_hash as string) || `swap_${Date.now()}`;
  const requestedAt = (swap.requested_at as number | undefined) ?? 0;
  const completedAt = (swap.completed_at as number | null | undefined) ?? null;
  const initiatedAt = (swap.initiated_at as number | null | undefined) ?? null;
  const tsSec = completedAt ?? initiatedAt ?? requestedAt;
  const timestamp = tsSec ? tsSec * 1000 : Date.now();
  const qtyFrom = Number(swap.qty_from ?? 0);
  return {
    id: `swap_${side}_${paymentHash}`,
    type: "swap",
    status: mapSwapStatus(swap.status as string | undefined),
    timestamp,
    amount: qtyFrom,
    // `qty_from` uses the from asset's precision, not the queried asset's.
    amountDisplay: formatAmount(qtyFrom, precision),
    fee: 0,
    feeDisplay: formatAmount(0, 8),
    asset: {} as UnifiedAsset,
    protocolData: { ...swap, side },
  };
}

/**
 * Lightning payment from `client.rln.listPayments()`. Direction comes from the
 * `inbound` flag; amount prefers `asset_amount`, else the BTC msat figure as sats.
 *
 * @param precision RGB asset precision; the millisatoshi fallback renders as BTC.
 */
export function convertPaymentToTransaction(
  payment: Record<string, unknown>,
  precision: number = 8,
): UnifiedTransaction {
  const inbound = Boolean(payment.inbound);
  const assetAmount = (payment.asset_amount as number | null | undefined) ?? null;
  const amtMsat = (payment.amt_msat as number | null | undefined) ?? null;
  const amount = assetAmount ?? (amtMsat
    ? toSafeAmountNumber(roundedMsatToSat(String(amtMsat)), "sat")
    : 0);
  const timestamp = (payment.created_at as number | undefined)
    ? (payment.created_at as number) * 1000
    : Date.now();
  return {
    id: (payment.payment_hash as string) || `pmt_${Date.now()}`,
    type: inbound ? "receive" : "send",
    status: mapPaymentStatus(payment.status as string | undefined),
    timestamp,
    amount,
    // Asset amounts use asset precision; the millisatoshi fallback is BTC.
    amountDisplay: formatAmount(amount, assetAmount !== null ? precision : 8),
    fee: 0,
    feeDisplay: formatAmount(0, 8),
    asset: {} as UnifiedAsset,
    to: payment.payee_pubkey as string | undefined,
    protocolData: payment,
  };
}
