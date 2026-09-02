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
  // `future` is the projected balance once every pending tx settles, so it is
  // what is OWNED; `future - settled` is the portion of that projected balance
  // that has not confirmed. The old `total: settled, pending: future`
  // reported the projected total as "pending" (so a UI summing total+pending
  // double-counts) and hid an unconfirmed receive from `total` entirely — and it
  // disagreed with this adapter's own `getBtcBalance()`, which already uses
  // `future` as the total. One adapter must not give two answers.
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
  // Same semantics as `RgbCore.rgbAssetBalance` (src/adapters/wdk/RgbCore.ts),
  // the shared source of truth the WDK RGB adapters use: `total` is the owned
  // amount (`future`, the projected total), `pending` is the unsettled DELTA.
  // This converter previously emitted `total = settled` and `pending = future`,
  // so a received-but-unconfirmed asset reported total 0 while the WDK adapter
  // for the same protocol reported the real figure.
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
 * @param precision Display precision of the transferred asset (finding E-F3).
 *   Defaults to 8, the BTC convention — which understates every non-8-precision
 *   asset by 10^(8-p), so a caller that can resolve the real precision must pass it.
 */
export function convertTransferToTransaction(
  transfer: Record<string, unknown>,
  precision: number = 8,
): UnifiedTransaction {
  return {
    id: (transfer.txid as string) || `tx_${Date.now()}`,
    type: mapTransferType(transfer.kind as string | undefined),
    status: mapTransferStatus(transfer.status as string | undefined),
    // `Transfer.created_at` is unix SECONDS (kaleido-sdk node-types.d.ts:3765-3771,
    // `@example 1691160765`). The engine convention is ms — both sibling
    // converters in this file convert (`convertSwapToTransaction` :165-166,
    // `convertPaymentToTransaction` :193-195). Passing seconds through put every
    // on-chain RGB transfer at ~1970, so `RgbAdapter.listTransactions`'
    // `fromTimestamp` filter dropped all of them and the merged history sorted
    // them last, always.
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
 * @param precision Display precision of the swap's FROM asset — `qty_from`'s unit
 *   (finding E-F3). Defaults to 8, correct only when the from-leg is BTC, so a
 *   caller that can resolve the real precision must pass it.
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
    // `qty_from` is denominated in the swap's FROM asset — which is not
    // necessarily the asset whose history was requested, so the caller resolves
    // and passes that asset's precision. `fee` is a literal 0 in sats.
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
 * @param precision Display precision of the payment's RGB asset (finding E-F3).
 *   Applied only on the `asset_amount` branch — the `amt_msat` fallback yields
 *   sats, always rendered at 8. Defaults to 8.
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
    // MIXED UNIT: `amount` above is asset base units when the payment carried an
    // `asset_amount`, and SATS when it fell back to `amt_msat / 1000`. Only the
    // first is denominated in the asset, so only the first uses its precision;
    // the sats branch is BTC and stays at 8 whatever the caller passes.
    amountDisplay: formatAmount(amount, assetAmount !== null ? precision : 8),
    fee: 0,
    feeDisplay: formatAmount(0, 8),
    asset: {} as UnifiedAsset,
    to: payment.payee_pubkey as string | undefined,
    protocolData: payment,
  };
}
