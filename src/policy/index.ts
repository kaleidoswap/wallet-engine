/** Pure signing and spend policy for engine and host boundaries. */

import type { ProtocolType } from '../types/base'
import { classifyDestination, type DestinationKind } from '../router/destination'
import { parseUnifiedReceiveURI, receiveMethodsOf } from '../receive/unifiedReceive'
import { isBtcAssetId } from '../lib/asset-id'

/**
 * Fund-moving / signing operations a policy can gate. `blindLiquidPset` and
 * `signLiquidPset` are not amount-capped — a PSET can carry multiple assets and
 * blinded values the `amountSat` model cannot authorize, so they are gated as
 * explicit signing grants instead.
 */
export type PolicyOperation =
  | 'send'
  | 'keysend'
  | 'signPsbt'
  | 'blindLiquidPset'
  | 'signLiquidPset'
  | 'signMessage'
  | 'swap'

export interface PolicyRequest {
  operation: PolicyOperation
  /** Protocol the operation runs on (the active adapter). */
  protocol?: ProtocolType
  /**
   * Amount in satoshis for send/keysend/swap. Omitted when not known/applicable.
   * For an asset-bearing send/keysend this is the satoshi carrier amount; the
   * asset itself is authorised separately through `assetId`/`assetAmount`.
   */
  amountSat?: number
  /**
   * Non-BTC asset moved by the operation: a swap's input asset, or the RGB
   * asset attached to a send/keysend. Omitted for satoshi-only operations.
   */
  assetId?: string
  /** Amount of `assetId` in raw base units, as a decimal string. */
  assetAmount?: string
  /** Raw destination string (invoice/address); classified internally for kind checks. */
  destination?: string
  /** Identifies the caller/app performing the op (deep link, dapp origin, MCP tool). */
  grantId?: string
}

/** A capability grant issued to one app/caller. */
export interface CapabilityGrant {
  id: string
  /** Operations this grant may perform. */
  operations: PolicyOperation[]
  /** Protocols this grant may act on. Omit = any. */
  protocols?: ProtocolType[]
  /** Per-transaction spend cap (sats) for send/keysend/swap. Omit = no grant cap. */
  maxAmountSat?: number
  /**
   * Per-asset raw-unit caps for asset-bearing send/keysend/swap. A grant that
   * sets any cap denies non-BTC assets it does not list.
   */
  maxAmountByAsset?: Record<string, string>
  /** Allowed destination kinds. Omit = any. */
  allowedDestinationKinds?: DestinationKind[]
  /** Exact-match destination allowlist. Omit = any destination. */
  destinationAllowlist?: string[]
}

export interface SigningPolicy {
  /**
   * Decision when no grant is identified. `'allow'` (default) enforces only the
   * global cap; `'deny'` requires an explicit matching grant for every op.
   */
  mode?: 'allow' | 'deny'
  /** Global per-transaction spend cap (sats), applied on top of any grant cap. */
  maxAmountSat?: number
  /**
   * Per-asset raw-unit caps for asset-bearing send/keysend/swap. A policy that
   * sets any cap denies non-BTC assets it does not list.
   */
  maxAmountByAsset?: Record<string, string>
  /** Per-app capability grants, resolved by `PolicyRequest.grantId`. */
  grants?: CapabilityGrant[]
}

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; code: string; reason: string; details?: unknown }

export class PolicyError extends Error {
  readonly code: string
  readonly details?: unknown
  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'PolicyError'
    this.code = code
    this.details = details
  }
}

const AMOUNT_OPS: ReadonlySet<PolicyOperation> = new Set(['send', 'keysend', 'swap'])

/** Include every unified payment rail; unknown embedded rails fail closed. */
function destinationKindsOf(destination: string): DestinationKind[] {
  const kinds: DestinationKind[] = [classifyDestination(destination).kind]
  const parsed = parseUnifiedReceiveURI(destination)
  if (!parsed) return kinds
  for (const method of receiveMethodsOf(parsed)) {
    const value = parsed[method]
    if (typeof value !== 'string' || value === '') continue
    // The on-chain address is already covered by the outer BIP21 classification.
    if (method === 'btcAddress') continue
    kinds.push(classifyDestination(value).kind)
  }
  return kinds
}

function deny(code: string, reason: string, details?: unknown): PolicyDecision {
  return { allowed: false, code, reason, ...(details === undefined ? {} : { details }) }
}

function isDecimalBaseUnits(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
}

/** Caps a policy level (global or grant) can set. */
interface AmountCaps {
  maxAmountSat?: number
  maxAmountByAsset?: Record<string, string>
}

/**
 * Authorise the non-BTC asset an amount-op carries against one level's caps.
 * A satoshi cap cannot bound another asset without a price oracle, so a level
 * that caps anything must list the asset explicitly; unlisted assets fail
 * closed. Returns null when allowed.
 */
function checkAssetCap(
  req: PolicyRequest,
  caps: AmountCaps,
  level: { overCode: string; label: string },
): PolicyDecision | null {
  if (caps.maxAmountSat == null && caps.maxAmountByAsset == null) return null
  const assetId = req.assetId!
  const hasAssetCap =
    caps.maxAmountByAsset != null && Object.prototype.hasOwnProperty.call(caps.maxAmountByAsset, assetId)
  const cap = hasAssetCap ? caps.maxAmountByAsset![assetId] : undefined
  if (cap == null) {
    return deny(
      'AMOUNT_UNKNOWN',
      `'${req.operation}' amount for asset '${assetId}' has no configured base-unit cap in ${level.label}`,
      { asset: assetId, cap: null },
    )
  }
  if (!isDecimalBaseUnits(cap)) {
    return deny(
      'AMOUNT_INVALID',
      `configured cap for asset '${assetId}' in ${level.label} is not a base-unit decimal string`,
      { asset: assetId, cap },
    )
  }
  if (req.assetAmount == null) {
    return deny(
      'AMOUNT_UNKNOWN',
      `'${req.operation}' amount for asset '${assetId}' is unknown but ${level.label} sets a cap`,
      { asset: assetId, cap },
    )
  }
  if (BigInt(req.assetAmount) > BigInt(cap)) {
    return deny(
      level.overCode,
      `amount ${req.assetAmount} of asset '${assetId}' exceeds ${level.label} limit ${cap}`,
      { asset: assetId, amount: req.assetAmount, cap },
    )
  }
  return null
}

/**
 * Evaluate a request against a policy. Pure — same input, same output, no I/O.
 */
export function evaluatePolicy(req: PolicyRequest, policy: SigningPolicy): PolicyDecision {
  // Runtime callers are not constrained by TypeScript. Reject malformed
  // amounts before comparing limits: NaN and negative values otherwise make
  // every `>` cap check false and silently bypass the policy.
  if (
    AMOUNT_OPS.has(req.operation) &&
    req.amountSat != null &&
    (!Number.isSafeInteger(req.amountSat) || req.amountSat <= 0)
  ) {
    return deny('AMOUNT_INVALID', `'${req.operation}' amount must be a positive safe integer`)
  }

  if (req.assetAmount != null && (!isDecimalBaseUnits(req.assetAmount) || req.assetAmount === '0')) {
    return deny(
      'AMOUNT_INVALID',
      `'${req.operation}' asset amount must be a positive base-unit decimal string`,
      { asset: req.assetId, amount: req.assetAmount },
    )
  }

  // An asset amount with no asset identity cannot be authorised by anything.
  if (req.assetAmount != null && (req.assetId == null || req.assetId.trim() === '')) {
    return deny('ASSET_UNKNOWN', `'${req.operation}' carries an asset amount without an asset id`, {
      amount: req.assetAmount,
    })
  }

  // Which value flows: a non-BTC swap moves only its input asset; a send or
  // keysend may carry an RGB asset on top of its satoshi amount, so both the
  // asset and the satoshi carrier are authorised (finding 15).
  const carriesAsset = AMOUNT_OPS.has(req.operation) && req.assetId != null && !isBtcAssetId(req.assetId)
  const checksSats = AMOUNT_OPS.has(req.operation) && !(carriesAsset && req.operation === 'swap')

  // 1. Global per-transaction caps, regardless of grants/mode. When a cap is set
  // for an amount-op but the amount is unknown, fail CLOSED: an unknown amount
  // must never slip past a spend limit (e.g. an unresolved amountless BOLT11).
  if (carriesAsset) {
    const denied = checkAssetCap(req, policy, { overCode: 'AMOUNT_OVER_GLOBAL_LIMIT', label: 'global policy' })
    if (denied) return denied
  }
  if (checksSats && policy.maxAmountSat != null) {
    if (req.amountSat == null) {
      return deny(
        'AMOUNT_UNKNOWN',
        `'${req.operation}' amount is unknown but a global spend limit is set`,
      )
    }
    if (req.amountSat > policy.maxAmountSat) {
      return deny(
        'AMOUNT_OVER_GLOBAL_LIMIT',
        `amount ${req.amountSat} exceeds global limit ${policy.maxAmountSat}`,
      )
    }
  }

  const grants = policy.grants ?? []
  const mode = policy.mode ?? 'allow'

  // 2. No grant identified.
  if (!req.grantId) {
    if (mode === 'deny') {
      return deny('NO_GRANT', `policy is default-deny and no grant was provided for '${req.operation}'`)
    }
    return { allowed: true } // default-allow: global cap already checked
  }

  // 3. Grant-scoped evaluation.
  const grant = grants.find((g) => g.id === req.grantId)
  if (!grant) {
    return deny('GRANT_NOT_FOUND', `no grant '${req.grantId}'`)
  }
  if (!grant.operations.includes(req.operation)) {
    return deny('OP_NOT_GRANTED', `grant '${grant.id}' may not '${req.operation}'`)
  }
  if (grant.protocols && req.protocol && !grant.protocols.includes(req.protocol)) {
    return deny('PROTOCOL_NOT_GRANTED', `grant '${grant.id}' may not act on ${req.protocol}`)
  }
  if (carriesAsset) {
    const denied = checkAssetCap(req, grant, {
      overCode: 'AMOUNT_OVER_GRANT_LIMIT',
      label: `grant '${grant.id}'`,
    })
    if (denied) return denied
  }
  if (checksSats && grant.maxAmountSat != null) {
    if (req.amountSat == null) {
      return deny(
        'AMOUNT_UNKNOWN',
        `'${req.operation}' amount is unknown but grant '${grant.id}' sets a spend limit`,
      )
    }
    if (req.amountSat > grant.maxAmountSat) {
      return deny(
        'AMOUNT_OVER_GRANT_LIMIT',
        `amount ${req.amountSat} exceeds grant '${grant.id}' limit ${grant.maxAmountSat}`,
      )
    }
  }
  if (grant.destinationAllowlist || grant.allowedDestinationKinds) {
    if (req.destination == null || req.destination.trim() === '') {
      return deny(
        'DEST_UNKNOWN',
        `grant '${grant.id}' restricts destinations but none was provided`,
      )
    }
    if (grant.destinationAllowlist && !grant.destinationAllowlist.includes(req.destination)) {
      return deny('DEST_NOT_ALLOWLISTED', `destination not in grant '${grant.id}' allowlist`)
    }
    if (grant.allowedDestinationKinds) {
      // Embedded rails are independent destinations; checking only the outer
      // BIP321 URI would let a disallowed invoice bypass the grant.
      for (const kind of destinationKindsOf(req.destination)) {
        if (!grant.allowedDestinationKinds.includes(kind)) {
          return deny('DEST_KIND_NOT_ALLOWED', `destination kind '${kind}' not allowed by grant '${grant.id}'`)
        }
      }
    }
  }
  return { allowed: true }
}

/** Asset fields a runtime caller can attach: typed camelCase or RLN node snake_case. */
export interface AssetTermsInput {
  assetId?: unknown
  asset_id?: unknown
  assetAmount?: unknown
  asset_amount?: unknown
}

export interface AssetTerms {
  assetId?: string
  assetAmount?: string
}

function assetAmountToBaseUnits(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return value.trim()
  // Anything else stringifies to a value `evaluatePolicy` rejects unless it is
  // a positive integer (`1.5`, `NaN`, `-1`, `[object Object]` all fail).
  return String(value)
}

/**
 * Normalise the asset terms attached to a send/keysend for policy evaluation.
 * Both spellings are read because different adapters honour different ones;
 * spellings that disagree are refused rather than resolved in the caller's
 * favour. A BTC identifier means no asset. Throws `PolicyError` on conflict.
 */
export function normalizeAssetTerms(input: AssetTermsInput): AssetTerms {
  const ids = [input.assetId, input.asset_id].filter((v) => v != null && v !== '')
  const amounts = [input.assetAmount, input.asset_amount].filter((v) => v != null && v !== '')
  if (ids.length === 2 && String(ids[0]).trim() !== String(ids[1]).trim()) {
    throw new PolicyError('ASSET_MISMATCH', 'assetId and asset_id disagree', { ids })
  }
  if (amounts.length === 2 && assetAmountToBaseUnits(amounts[0]) !== assetAmountToBaseUnits(amounts[1])) {
    throw new PolicyError('ASSET_MISMATCH', 'assetAmount and asset_amount disagree', { amounts })
  }
  const assetId = ids.length > 0 ? String(ids[0]).trim() : undefined
  const assetAmount = amounts.length > 0 ? assetAmountToBaseUnits(amounts[0]) : undefined
  if (assetId != null && isBtcAssetId(assetId)) return {}
  return {
    ...(assetId != null && assetId !== '' ? { assetId } : {}),
    ...(assetAmount != null ? { assetAmount } : {}),
  }
}

/** Throwing wrapper for imperative call sites (e.g. ProtocolManager). No-op when policy is undefined. */
export function enforcePolicy(req: PolicyRequest, policy?: SigningPolicy): void {
  if (!policy) return
  const d = evaluatePolicy(req, policy)
  if (!d.allowed) {
    throw new PolicyError(d.code, `Policy denied '${req.operation}': ${d.reason}`, d.details)
  }
}
