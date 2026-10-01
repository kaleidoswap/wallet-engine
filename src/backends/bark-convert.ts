import { BarkBackendError, type BarkValue } from '../types/bark-native.js'

export function positiveSats(value: number): bigint {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_100_000_000_000_000) {
    throw new BarkBackendError('VALIDATION_ERROR', 'Expected positive integer satoshis')
  }
  return BigInt(value)
}

export function nativeNumber(value: bigint): number {
  if (typeof value !== 'bigint' || value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BarkBackendError('SDK_ERROR', 'Bark returned an unsafe integer')
  }
  return Number(value)
}

/** Includes nested UniFFI enum fields; no BigInt or native handles escape. */
export function barkValue(value: unknown): BarkValue {
  if (value == null) return null
  if (typeof value === 'bigint') return nativeNumber(value)
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(barkValue)
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, barkValue(v)]))
  }
  throw new BarkBackendError('SDK_ERROR', 'Bark returned an unsupported value')
}

export function vtxoIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id.trim())) {
    throw new BarkBackendError('VALIDATION_ERROR', 'Select at least one VTXO explicitly')
  }
  return [...new Set(ids)]
}
