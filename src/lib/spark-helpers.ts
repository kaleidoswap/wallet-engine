/**
 * Pure, side-effect-free helpers for the Spark adapter, so the adapter file stays
 * focused on the IProtocolAdapter surface and RPC orchestration.
 */

import { bech32m } from '@scure/base'
import type { TransactionStatus } from '../types/base'
import { normalizeTxHash } from './spark-sent-token-records'

// Amount display formatting is centralized in ./amount (was duplicated here).
export { formatAmount } from './amount'

/**
 * Map a Spark transfer status to our unified TransactionStatus.
 *
 * The SDK ships two vocabularies: the `TRANSFER_STATUS_*` enum for native
 * transfers, and a looser lowercase set for Lightning send requests
 * (completed/succeeded/failed/…) that has drifted across versions. Both are mapped
 * here so callers need not know which a record came from.
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
 * Wrap a promise with a rejection timeout, to fail fast on slow Spark RPCs — the
 * SDK's own 30s ceiling is too long for popup UI.
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
 * True when a balance snapshot is a fresh / still-syncing wallet: zero sats AND no
 * token balances. Empty snapshots get a shorter cache TTL so the UI doesn't stick
 * on "0 sats" mid-sync.
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
 * Decode a bech32m Spark token id (`btkn1…`) to normalized raw hex. Returns `""`
 * on falsy input or decode failure, so non-bech32m tokens fall through to the
 * caller's other matchers.
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
 * Cross-format token id comparison: direct string match, else decode both via
 * bech32m / normalizeTxHash and compare raw forms. False when either is empty.
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
 * Parse one of the SDK's polymorphic expiry shapes (Date | number | ISO string)
 * into a finite ms timestamp; undefined when unparseable so callers can branch.
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
