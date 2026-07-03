/**
 * Pure helpers for the RGB adapter.
 *
 * Extracted from src/protocols/rgb/adapter.ts so the adapter file can stay
 * focused on the IProtocolAdapter surface + SDK orchestration. Everything in
 * this module is side-effect free, has no `this` dependencies, and is
 * covered by tests/unit/rgb-helpers.test.ts.
 *
 * Adding to this module: keep helpers pure (no class state, no SDK calls).
 * Anything that needs the kaleido SDK client or the adapter's own config
 * belongs in adapter.ts.
 */

import type { TransactionStatus, TransactionType } from "../types/base";

/**
 * Render a raw integer amount in the asset's display precision.
 * Always emits `precision` fractional digits — the caller can trim trailing
 * zeros if it wants a tighter rendering.
 */
export function formatAmount(amount: number, precision: number): string {
  return (amount / Math.pow(10, precision)).toFixed(precision);
}

/**
 * Map the SDK's transfer `kind` field to our unified TransactionType.
 *
 * The SDK is inconsistent about case + naming — both raw lowercase strings
 * and PascalCase ("ReceiveAsset", "SendAsset") have been observed. Defaults
 * to "send" for unknown / undefined input so legacy entries don't display
 * as a confusing third state.
 */
export function mapTransferType(kind?: string): TransactionType {
  if (!kind) return "send";
  if (kind.includes("receive") || kind.includes("ReceiveAsset")) return "receive";
  if (kind.includes("send") || kind.includes("SendAsset")) return "send";
  return "send";
}

/**
 * Map the SDK's transfer status string to our unified TransactionStatus.
 *
 * SDK casing has drifted between releases; we accept both. "WaitingCounterparty"
 * is RGB-specific (lightning transfer waiting on the receiver) and maps to
 * pending so the UI keeps showing the spinner rather than green-checking too
 * early.
 */
export function mapTransferStatus(status?: string): TransactionStatus {
  if (!status) return "pending";
  if (status === "Settled" || status === "settled") return "confirmed";
  if (status === "Failed" || status === "failed") return "failed";
  if (status === "WaitingCounterparty") return "pending";
  return "pending";
}

/**
 * Map a Lightning-payment status string to our unified TransactionStatus.
 *
 * Three variants of "succeeded" have shown up in the SDK across versions —
 * we accept all three to insulate the wallet UI from upstream churn.
 */
export function mapPaymentStatus(status?: string): TransactionStatus {
  if (!status) return "pending";
  if (status === "succeeded" || status === "success" || status === "Succeeded") return "confirmed";
  if (status === "failed" || status === "Failed") return "failed";
  return "pending";
}

/**
 * Map a maker/taker swap status string to our unified TransactionStatus.
 *
 * The SDK historically returned PascalCase ("Completed") and lowercase
 * ("completed", "success", "error") interchangeably depending on whether
 * the response came from the maker or taker side. The mapper accepts both
 * so a refactor of the SDK doesn't quietly flip swaps to "pending".
 */
export function mapSwapStatus(status?: string): TransactionStatus {
  if (!status) return "pending";
  if (status === "completed" || status === "success" || status === "Completed") return "confirmed";
  if (status === "failed" || status === "error" || status === "Failed") return "failed";
  return "pending";
}
