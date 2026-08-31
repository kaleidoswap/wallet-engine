/** Canonical decimal amount in millisatoshis. */
export type MillisatoshiAmount = string

/** Canonical decimal amount in satoshis. */
export type SatoshiAmount = string

export const MAX_BITCOIN_SUPPLY_SAT = '2100000000000000' as const
export const MAX_BITCOIN_SUPPLY_MSAT = '2100000000000000000' as const

const MSAT_PER_SAT = 1000n
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)

function parseCanonicalAmount(value: string, maximum: bigint, unit: 'msat' | 'sat'): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${unit} amount must be a canonical unsigned decimal string`)
  }

  const amount = BigInt(value)
  if (amount > maximum) {
    throw new RangeError(`${unit} amount exceeds the Bitcoin monetary range`)
  }
  return amount
}

/** Parse and validate an exact millisatoshi amount without converting through `number`. */
export function parseMsat(value: MillisatoshiAmount): bigint {
  return parseCanonicalAmount(value, BigInt(MAX_BITCOIN_SUPPLY_MSAT), 'msat')
}

/** Parse and validate an exact satoshi amount without converting through `number`. */
export function parseSat(value: SatoshiAmount): bigint {
  return parseCanonicalAmount(value, BigInt(MAX_BITCOIN_SUPPLY_SAT), 'sat')
}

/** Convert whole satoshis to millisatoshis exactly. */
export function satToMsat(value: SatoshiAmount): MillisatoshiAmount {
  return (parseSat(value) * MSAT_PER_SAT).toString()
}

/** Convert millisatoshis to whole satoshis, rejecting sub-satoshi values. */
export function msatToSat(value: MillisatoshiAmount): SatoshiAmount {
  const amount = parseMsat(value)
  if (amount % MSAT_PER_SAT !== 0n) {
    throw new RangeError('msat amount does not represent a whole satoshi')
  }
  return (amount / MSAT_PER_SAT).toString()
}

/**
 * Explicit adapter-boundary conversion for SDKs that require `number`. Values JS
 * cannot represent exactly are rejected before conversion.
 */
export function toSafeAmountNumber(value: string, unit: 'msat' | 'sat'): number {
  const amount = unit === 'msat' ? parseMsat(value) : parseSat(value)
  if (amount > MAX_SAFE_INTEGER) {
    throw new RangeError(`${unit} amount exceeds JavaScript's safe integer range`)
  }
  return Number(amount)
}

// Descriptive aliases for consumers that prefer full unit names.
export const parseMillisatoshi = parseMsat
export const parseSatoshi = parseSat
export const satsToMsats = satToMsat
export const msatsToSats = msatToSat
