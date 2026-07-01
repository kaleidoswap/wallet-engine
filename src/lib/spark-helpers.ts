/**
 * Pure helpers for the Spark adapter.
 *
 * Extracted from the extension's spark adapter so the adapter file can stay
 * focused on the IProtocolAdapter surface + RPC orchestration. Everything in
 * this module is side-effect free.
 */

import { bech32m } from '@scure/base'
import type { TransactionStatus } from '../types/base'
import { normalizeTxHash } from './spark-sent-token-records'

/**
 * Render a raw integer amount in the asset's display precision.
 * Always emits exactly `precision` decimal digits (no trailing-zero trim) —
 * callers that want a tighter rendering should post-process.
 */
export function formatAmount(amount: number, precision: number): string {
  return (amount / Math.pow(10, precision)).toFixed(precision)
}

/**
 * Map a Spark transfer status string to our unified TransactionStatus.
 *
 * The Spark SDK ships two related but distinct status vocabularies:
 *  1. Native transfers use the `TRANSFER_STATUS_*` enum from the SDK
 *     (COMPLETED / EXPIRED / RETURNED / SENDER_INITIATED /
 *     RECEIVER_KEY_TWEAKED).
 *  2. Lightning send requests use a looser lowercase vocabulary
 *     (`completed` / `complete` / `succeeded` / `success` / `failed` /
 *     `error`) which has drifted across SDK versions.
 *
 * Both are mapped here so callers don't need to know which vocabulary a
 * given record came from.
 */
export function mapTransferStatus(status?: string): TransactionStatus {
  if (!status) return 'pending'

  // SDK TransferStatus enum keys.
  if (status === 'TRANSFER_STATUS_COMPLETED') return 'confirmed'
  if (status === 'TRANSFER_STATUS_EXPIRED' || status === 'TRANSFER_STATUS_RETURNED') {
    return 'failed'
  }
  if (
    status === 'TRANSFER_STATUS_SENDER_INITIATED' ||
    status === 'TRANSFER_STATUS_RECEIVER_KEY_TWEAKED'
  ) {
    return 'pending'
  }

  // LightningSendRequest status vocabulary — case-insensitive.
  const s = status.toLowerCase()
  if (s === 'completed' || s === 'complete' || s === 'succeeded' || s === 'success') {
    return 'confirmed'
  }
  if (s === 'failed' || s === 'error') return 'failed'

  return 'pending'
}

/**
 * Wrap a promise with a rejection timeout. Used to fail fast on slow Spark
 * RPC calls; the SDK's own 30 s ceiling is too long for popup UI.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ])
}

/**
 * True when a Spark balance snapshot represents a fresh / still-syncing
 * wallet — zero sats AND no token balances. The adapter applies a shorter
 * TTL to empty snapshots so the UI doesn't get stuck on "0 sats" while the
 * Spark wallet syncs.
 */
export function isEmptyBalance(value: {
  balance?: bigint | number | string
  tokenBalances?: Map<unknown, unknown> | unknown
}): boolean {
  const raw = value?.balance
  const sats = typeof raw === 'bigint' ? raw : BigInt(raw ?? 0)
  const tokenCount = value?.tokenBalances instanceof Map ? value.tokenBalances.size : 0
  return sats === 0n && tokenCount === 0
}

/** Convert a Uint8Array to lowercase hex string. */
export function u8aToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Convert a big-endian Uint8Array to bigint (uint128 max). */
export function u8aToBigInt(bytes: Uint8Array): bigint {
  let result = 0n
  for (const b of bytes) result = (result << 8n) | BigInt(b)
  return result
}

/** Hex tx hash from raw bytes, run through the project's normalizer. */
export function txHashFromBytes(bytes: Uint8Array): string {
  return normalizeTxHash(u8aToHex(bytes))
}

/** Normalized raw token id from raw bytes; empty string when bytes are missing. */
export function rawTokenIdFromBytes(bytes: Uint8Array | undefined): string {
  return bytes ? normalizeTxHash(u8aToHex(bytes)) : ''
}

/**
 * Decode a bech32m-encoded Spark token id (e.g. `btkn1…`) back to its
 * normalized raw hex form. Returns `""` for falsy input or decode failures —
 * tokens that aren't bech32m-encoded simply round-trip through the empty
 * string and fall back to the caller's other matchers.
 */
export function rawTokenIdFromBech32mTokenId(tokenId: string | undefined): string {
  if (!tokenId) return ''
  try {
    const decoded = bech32m.decode(tokenId as `${string}1${string}`, 500)
    return rawTokenIdFromBytes(new Uint8Array(bech32m.fromWords(decoded.words)))
  } catch {
    return ''
  }
}

/**
 * Cross-format token id comparison: matches identical strings directly,
 * otherwise decodes both via bech32m / normalizeTxHash and compares the
 * raw forms. Returns false when either side is empty.
 */
export function tokenRefsMatch(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = left?.trim()
  const normalizedRight = right?.trim()
  if (!normalizedLeft || !normalizedRight) return false
  if (normalizedLeft === normalizedRight) return true

  const leftRaw = rawTokenIdFromBech32mTokenId(normalizedLeft) || normalizeTxHash(normalizedLeft)
  const rightRaw =
    rawTokenIdFromBech32mTokenId(normalizedRight) || normalizeTxHash(normalizedRight)
  return !!leftRaw && leftRaw === rightRaw
}

/**
 * Parse one of the SDK's polymorphic expiry shapes (Date | number | ISO
 * string) into a finite millisecond timestamp. Returns undefined for
 * unparseable / falsy / Infinity values so callers can branch on absence.
 */
export function parseSdkExpiryMs(expiry: unknown): number | undefined {
  if (!expiry) return undefined
  if (expiry instanceof Date) {
    const time = expiry.getTime()
    return Number.isFinite(time) ? time : undefined
  }
  if (typeof expiry === 'number') {
    return Number.isFinite(expiry) ? expiry : undefined
  }
  if (typeof expiry === 'string') {
    const time = new Date(expiry).getTime()
    return Number.isFinite(time) ? time : undefined
  }
  return undefined
}
