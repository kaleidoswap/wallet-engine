/**
 * SDK ↔ unified-shape converters for the RGB adapter. Every function is
 * side-effect free, has no `this` dependencies, and imports types only.
 */

import type { AssetBalanceResponse, BtcBalanceResponse } from "kaleido-sdk/rln";
import type { UnifiedAsset, UnifiedTransaction } from "../types/base";
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
 * sub-balances. Only the vanilla portion is the BTC asset's balance — colored sats
 * are accounted under each RGB asset, and must never show as spendable BTC.
 */
export function convertBtcBalance(btcBalance: BtcBalanceResponse): UnifiedAsset["balance"] {
  const vanilla = btcBalance.vanilla ?? { settled: 0, future: 0, spendable: 0 };
  return {
    total: vanilla.settled || 0,
    available: vanilla.spendable || 0,
    pending: vanilla.future || 0,
    totalDisplay: formatAmount(vanilla.settled || 0, 8),
    availableDisplay: formatAmount(vanilla.spendable || 0, 8),
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
  return {
    total: balance.settled || 0,
    available: balance.spendable || 0,
    pending: balance.future || 0,
    locked: balance.offchain_outbound || 0,
    offchain_outbound: balance.offchain_outbound || 0,
    offchain_inbound: balance.offchain_inbound || 0,
    totalDisplay: formatAmount(balance.settled || 0, precision),
    availableDisplay: formatAmount(balance.spendable || 0, precision),
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
  const total = balance?.settled || 0;
  const available = balance?.spendable || 0;
  const pending = balance?.future || 0;

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
 */
export function convertTransferToTransaction(
  transfer: Record<string, unknown>,
): UnifiedTransaction {
  return {
    id: (transfer.txid as string) || `tx_${Date.now()}`,
    type: mapTransferType(transfer.kind as string | undefined),
    status: mapTransferStatus(transfer.status as string | undefined),
    timestamp: (transfer.created_at as number) || Date.now(),
    amount: (transfer.amount as number) || 0,
    amountDisplay: formatAmount((transfer.amount as number) || 0, 8),
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
 */
export function convertSwapToTransaction(
  swap: Record<string, unknown>,
  side: "maker" | "taker",
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
    amountDisplay: formatAmount(qtyFrom, 8),
    fee: 0,
    feeDisplay: formatAmount(0, 8),
    asset: {} as UnifiedAsset,
    protocolData: { ...swap, side },
  };
}

/**
 * Lightning payment from `client.rln.listPayments()`. Direction comes from the
 * `inbound` flag; amount prefers `asset_amount`, else the BTC msat figure as sats.
 */
export function convertPaymentToTransaction(payment: Record<string, unknown>): UnifiedTransaction {
  const inbound = Boolean(payment.inbound);
  const assetAmount = (payment.asset_amount as number | null | undefined) ?? null;
  const amtMsat = (payment.amt_msat as number | null | undefined) ?? null;
  const amount = assetAmount ?? (amtMsat ? Math.floor(amtMsat / 1000) : 0);
  const timestamp = (payment.created_at as number | undefined)
    ? (payment.created_at as number) * 1000
    : Date.now();
  return {
    id: (payment.payment_hash as string) || `pmt_${Date.now()}`,
    type: inbound ? "receive" : "send",
    status: mapPaymentStatus(payment.status as string | undefined),
    timestamp,
    amount,
    amountDisplay: formatAmount(amount, 8),
    fee: 0,
    feeDisplay: formatAmount(0, 8),
    asset: {} as UnifiedAsset,
    to: payment.payee_pubkey as string | undefined,
    protocolData: payment,
  };
}
