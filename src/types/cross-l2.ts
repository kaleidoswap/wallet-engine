/**
 * Cross-L2 atomic swap types (Spark <-> Arkade and similar pairs).
 *
 * Mirrored in kaleidoswap-maker/app/models/cross_l2.py — keep shapes in sync.
 *
 * The destination side uses our custom SHA256-VHTLC contract type
 * (registered with the @arkade-os/sdk ContractManager via the proxy's
 * sha256VhtlcContract.js), so the SAME sha256(preimage) hash secures both
 * sides of a swap. Single hash, no cheating window — the taker generates
 * preimage P, supplies sha256(P) as `payment_hash`, and the maker locks
 * both Lightning HODL and Arkade SHA256-VHTLC against it.
 *
 * The atomic-swap design lives in docs/atomic-swaps/spark-arkade.md.
 */

import type { Layer } from './base'

export type BackendId = 'spark' | 'arkade' | 'rln' | 'boltz'

/**
 * Phase of a cross-L2 swap. Rides alongside the maker's existing
 * SwapOrderStatus on the same SwapOrder document.
 *
 *   quoted          quote handed to taker, nothing locked
 *   dest_locked     destination L2 (e.g. Arkade) VHTLC funded
 *   source_invoiced source L2 (e.g. Spark) HODL invoice issued
 *   source_locked   taker paid HODL on source, htlc pending
 *   dest_claimed    taker revealed preimage on destination
 *   source_settled  maker captured preimage, settled HODL on source
 *   refunded        timeout path completed on both sides
 */
export type CrossL2Phase =
  | 'quoted'
  | 'dest_locked'
  | 'source_invoiced'
  | 'source_locked'
  | 'dest_claimed'
  | 'source_settled'
  | 'refunded'

/**
 * Parameters for a SHA256-VHTLC contract on Arkade.
 *
 * Pubkeys are 32-byte x-only hex; `hash` is sha256(preimage), 32-byte hex
 * — same hash that secures the source-side Lightning HODL invoice.
 */
export interface VhtlcParams {
  sender: string
  receiver: string
  server: string
  /** sha256(preimage), 32-byte hex. Same hash on both sides of the swap. */
  hash: string
  refund_locktime: number
  claim_delay: number
  refund_delay: number
  refund_no_receiver_delay: number
}

export interface HodlInvoiceDescriptor {
  encoded_invoice: string
  payment_hash: string
  amount_sats: number
  expires_at: number
}

/**
 * Descriptor for an outbound Spark HTLC payment, used in the
 * Arkade -> Spark direction. The maker SENDs a Spark HTLC to the taker;
 * once the taker claims it, the preimage propagates back to the maker via
 * `Payment.htlc_details.preimage` so the maker can claim its source-side
 * Arkade VHTLC. The descriptor carries the SDK payment id needed to drive
 * the polling.
 */
export interface SparkHtlcSendDescriptor {
  payment_id: string
  payment_hash: string
  amount_sats: number
  receiver_address: string
  expires_at: number
}

export interface CrossL2QuoteRequest {
  from_layer: Layer
  to_layer: Layer
  amount_sats: number
}

export interface CrossL2Quote {
  quote_id: string
  from_layer: Layer
  to_layer: Layer
  amount_in_sats: number
  amount_out_sats: number
  fee_sats: number
  source_cltv_expiry_seconds: number
  destination_refund_locktime_seconds: number
  safety_margin_seconds: number
  expires_at: number
}

/**
 * Cross-L2 swap initiation, taker-driven.
 *
 * The TAKER generates a single secret preimage P and supplies sha256(P)
 * as `payment_hash`. The same hash is used on BOTH sides of the swap.
 *
 * Spark -> Arkade direction:
 *   - source: Spark Lightning HODL committed to sha256(P) (taker pays)
 *   - destination: Arkade SHA256-VHTLC committed to sha256(P) (maker
 *     funds, taker claims with P). `receiver_dest_pubkey` = taker's
 *     Arkade x-only pubkey (VHTLC receiver). `taker_spark_address` is
 *     unused.
 *
 * Arkade -> Spark direction:
 *   - source: Arkade SHA256-VHTLC committed to sha256(P) (taker funds,
 *     maker claims with P). `receiver_dest_pubkey` = taker's Arkade
 *     x-only pubkey (VHTLC sender — refund-path beneficiary).
 *   - destination: Spark HTLC payment to `taker_spark_address` (maker
 *     sends, taker claims with P; preimage propagates back to maker
 *     via Payment.htlc_details.preimage).
 *
 * Atomicity holds because a single preimage unlocks both sides.
 */
export interface CrossL2InitiatePayload {
  quote_id: string
  /** sha256(preimage), 32-byte hex. Used for both source and dest. */
  payment_hash: string
  /**
   * Taker's Arkade x-only pubkey (32-byte hex). VHTLC receiver in
   * Spark->Arkade; VHTLC sender in Arkade->Spark.
   */
  receiver_dest_pubkey: string
  /**
   * Taker's Spark address. Required for Arkade->Spark (maker SENDs the
   * Spark HTLC to this address). Ignored for Spark->Arkade.
   */
  taker_spark_address?: string
}

/**
 * Direction-aware /initiate response.
 *
 * Spark -> Arkade:
 *   - `source_invoice` is the Spark Lightning HODL invoice (taker pays).
 *   - `dest_vhtlc_address` / `vhtlc_params` describe the destination
 *     Arkade VHTLC the maker has already FUNDED (taker claims with P).
 *
 * Arkade -> Spark:
 *   - `source_invoice` is null (no source Lightning invoice).
 *   - `dest_vhtlc_address` / `vhtlc_params` describe the SOURCE Arkade
 *     VHTLC the taker MUST FUND (maker later claims with P). Despite the
 *     legacy field name, it is the source-side VHTLC in this direction.
 */
export interface CrossL2InitiateResponse {
  swap_id: string
  source_invoice: string | null
  dest_vhtlc_address: string
  vhtlc_params: VhtlcParams
  vhtlc_script_hex: string
  expires_at: number
}

export interface CrossL2SwapStatus {
  swap_id: string
  phase: CrossL2Phase
  preimage_observed: boolean
  source_settled_at?: number
  failure_reason?: string
}

export interface RefundReceipt {
  swap_id: string
  source_refund_txid?: string
  dest_refund_txid?: string
  refunded_at: number
}
