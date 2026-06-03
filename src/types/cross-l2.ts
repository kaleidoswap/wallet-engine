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
 * as `payment_hash`. The same hash is used on BOTH sides:
 *   - source: Spark Lightning HODL committed to sha256(P)
 *   - destination: Arkade SHA256-VHTLC committed to sha256(P)
 * Atomicity holds because knowledge of P unlocks both sides; the taker
 * reveals P on Arkade by claiming the VHTLC, the maker scrapes P from
 * the spend witness and settles the HODL on Spark.
 */
export interface CrossL2InitiatePayload {
  quote_id: string
  /** sha256(preimage), 32-byte hex. Used for both source HODL and dest SHA256-VHTLC. */
  payment_hash: string
  receiver_dest_pubkey: string
}

export interface CrossL2InitiateResponse {
  swap_id: string
  source_invoice: string
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
