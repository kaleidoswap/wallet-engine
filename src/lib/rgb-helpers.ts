/**
 * Pure helpers for the RGB adapter — side-effect free, no `this` dependencies.
 * Anything needing the kaleido SDK client or adapter config belongs in adapter.ts.
 */

import type { TransactionStatus, TransactionType } from "../types/base";

// Amount display formatting is centralized in ./amount (was duplicated here).
export { formatAmount } from "./amount";

/**
 * Map the SDK's transfer `kind` to our unified TransactionType. The SDK is
 * inconsistent about case and naming (raw lowercase and PascalCase both observed);
 * unknown input defaults to "send" rather than a confusing third state.
 */
export function mapTransferType(kind?: string): TransactionType {
  if (!kind) return "send";
  if (kind.includes("receive") || kind.includes("ReceiveAsset")) return "receive";
  if (kind.includes("send") || kind.includes("SendAsset")) return "send";
  return "send";
}

/**
 * Map the SDK's transfer status to our unified TransactionStatus, accepting both
 * casings. "WaitingCounterparty" is RGB-specific and maps to pending, so the UI
 * keeps its spinner rather than green-checking early.
 */
export function mapTransferStatus(status?: string): TransactionStatus {
  if (!status) return "pending";
  if (status === "Settled" || status === "settled") return "confirmed";
  if (status === "Failed" || status === "failed") return "failed";
  if (status === "WaitingCounterparty") return "pending";
  return "pending";
}

/**
 * Map a Lightning-payment status to our unified TransactionStatus. Three variants
 * of "succeeded" have appeared across SDK versions; all are accepted.
 */
export function mapPaymentStatus(status?: string): TransactionStatus {
  if (!status) return "pending";
  if (status === "succeeded" || status === "success" || status === "Succeeded") return "confirmed";
  if (status === "failed" || status === "Failed") return "failed";
  return "pending";
}

/**
 * Map a maker/taker swap status to our unified TransactionStatus. The SDK has
 * returned PascalCase and lowercase interchangeably depending on side, so both are
 * accepted — otherwise an SDK refactor quietly flips swaps to "pending".
 */
export function mapSwapStatus(status?: string): TransactionStatus {
  if (!status) return "pending";
  if (
    status === "completed" ||
    status === "success" ||
    status === "Completed" ||
    status === "Succeeded"
  ) {
    return "confirmed";
  }
  if (
    status === "failed" ||
    status === "error" ||
    status === "Failed" ||
    status === "Expired"
  ) {
    return "failed";
  }
  return "pending";
}
