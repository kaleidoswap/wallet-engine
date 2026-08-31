/**
 * SDK ↔ unified-shape converters for the RGB adapter.
 *
 * Extracted from src/protocols/rgb/adapter.ts so the conversion logic lives
 * in one place and the adapter is closer to "what RPCs do I call". Every
 * function here is side-effect free, has no `this` dependencies, and only
 * imports types — no SDK client, no module state.
 *
 * Covered by tests/unit/rgb-converters.test.ts.
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
// Three slightly different upstream shapes; the unified `UnifiedAsset["balance"]`
// is the projection we render. Each converter is the *only* place that
// knows the field names of its specific SDK response — anything downstream
// reads the unified shape.

/**
 * `wallet.getBtcBalance()` returns BTC split into "vanilla" (regular) and
 * "colored" (RGB-allocated) sub-balances. The wallet UI only surfaces the
 * vanilla portion as the BTC asset's balance — colored sats are accounted
 * for under each RGB asset's own balance. Locks the policy: don't show
 * colored sats as spendable BTC.
 */
export function convertBtcBalance(btcBalance: BtcBalanceResponse): UnifiedAsset["balance"] {
  const vanilla = btcBalance.vanilla ?? { settled: 0, future: 0, spendable: 0 };
  // `future` is the projected balance once every pending tx settles, so it is
  // what is OWNED; `spendable` is what can be sent right now and `future -
  // spendable` is the unsettled delta. The old `total: settled, pending: future`
  // reported the projected total as "pending" (so a UI summing total+pending
  // double-counts) and hid an unconfirmed receive from `total` entirely — and it
  // disagreed with this adapter's own `getBtcBalance()`, which already uses
  // `future` as the total. One adapter must not give two answers.
  const spendable = vanilla.spendable || 0;
  const future = vanilla.future || 0;
  const owned = future || vanilla.settled || spendable || 0;
  return {
    total: owned,
    available: spendable,
    pending: Math.max(0, future - spendable),
    totalDisplay: formatAmount(owned, 8),
    availableDisplay: formatAmount(spendable, 8),
  };
}

/**
 * `wallet.getAssetBalance(assetId)` returns the per-asset SDK balance.
 * Exposes the off-chain inbound/outbound capacities — both shown in the
 * channel-aware balance breakdown — and treats `offchain_outbound` as
 * `locked` for legacy callers that don't know about the off-chain split.
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
  const owned = future || settled || spendable || 0;
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
 * `client.rln.listAssets()` returns balance as a plain `Record<string, number>`
 * — same field names as the SDK shape but flatter and `undefined`-safe.
 * Same projection as `convertSdkBalance` but no required-field assumptions.
 */
export function convertNodeBalance(
  balance: Record<string, number> | undefined,
  precision: number = 8,
): UnifiedAsset["balance"] {
  // Same semantics as `convertSdkBalance` above / `RgbCore.rgbAssetBalance`.
  const settled = balance?.settled || 0;
  const available = balance?.spendable || 0;
  const future = balance?.future || 0;
  const total = future || settled || available || 0;
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
 * Build a `UnifiedAsset` from the raw `client.rln.listAssets()` payload.
 * Precision defaults to 8 (BTC convention) when the node omits it —
 * legacy assets pre-RGB20 sometimes don't carry an explicit precision.
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
// Three sources of RGB activity — on-chain transfers, lightning payments,
// and maker/taker swaps — project into the same `UnifiedTransaction` shape
// so the activity view doesn't have to render-switch on protocol details.

/**
 * On-chain RGB transfer from `client.rln.listTransfers()`. `asset` is left
 * as an empty placeholder; the caller (Activity view) joins on `asset_id`
 * to populate it via the asset inventory.
 */
export function convertTransferToTransaction(
  transfer: Record<string, unknown>,
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
 * Maker/taker swap entry from `client.rln.listSwaps()`. The same swap
 * appears once per side — `side` distinguishes them in the rendered id
 * so a maker and taker view of the same swap don't collide.
 *
 * Timestamp resolution: prefer `completed_at`, then `initiated_at`, then
 * `requested_at` (all in seconds — converted to ms here).
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
 * Lightning payment entry from `client.rln.listPayments()`. Inbound vs
 * outbound is determined by the `inbound` flag (we render as receive vs
 * send). Amount resolution prefers `asset_amount` (for RGB-asset payments)
 * then falls back to converting the BTC msat figure to sats.
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
