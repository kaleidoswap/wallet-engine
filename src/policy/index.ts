/**
 * Signing / spend policy
 * ----------------------
 * A pure, portable gate for fund-moving and signing operations, centralizing checks
 * that would otherwise scatter across adapters and hosts: per-transaction spend
 * limits, destination allowlists, and per-app capability grants.
 *
 * `evaluatePolicy` is pure (no I/O, no globals), so it is trivially testable and
 * ports cleanly to Rust/Kotlin/Swift. Hosts wire it in via `ProtocolManager`
 * (opt-in) or call it at their own boundary.
 *
 * DEFAULT-ALLOW: a policy only ever tightens behaviour, so with none set the engine
 * behaves as before. `mode: 'deny'` flips to default-deny, requiring an explicit
 * matching grant.
 */

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
  /** Amount in satoshis for send/keysend/swap. Omitted when not known/applicable. */
  amountSat?: number
  /** Non-BTC swap input asset. Omitted for satoshi-denominated operations. */
  assetId?: string
  /** Non-BTC swap input amount in base units, as a decimal string. */
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
   * Per-asset swap caps in each asset's own base units. Decimal strings are
   * parsed with BigInt; no price conversion or floating-point coercion occurs.
   * When a cap policy is active, an unlisted non-BTC asset remains denied.
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

/**
 * Every destination kind a request could actually be paid through: the outer
 * string, plus each payment rail embedded in it when it is a unified BIP321 URI.
 * Fails CLOSED — a rail whose value does not classify contributes 'UNKNOWN',
 * which no sane grant allowlists, so an unparseable rail denies rather than
 * silently disappearing.
 */
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

  // 1. Global per-transaction cap, regardless of grants/mode. When a cap is set for
  // an amount-op but the amount is unknown, fail CLOSED: an unknown amount must
  // never slip past a spend limit (e.g. an unresolved amountless BOLT11).
  const isNonBtcSwap = req.operation === 'swap' && req.assetId != null && !isBtcAssetId(req.assetId)
  const hasGlobalCap = policy.maxAmountSat != null || policy.maxAmountByAsset != null

  if (isNonBtcSwap && hasGlobalCap) {
    const hasAssetCap =
      policy.maxAmountByAsset != null &&
      Object.prototype.hasOwnProperty.call(policy.maxAmountByAsset, req.assetId!)
    const cap = hasAssetCap ? policy.maxAmountByAsset![req.assetId!] : undefined
    if (cap == null) {
      return deny(
        'AMOUNT_UNKNOWN',
        `'swap' amount for asset '${req.assetId}' has no configured base-unit cap`,
        { asset: req.assetId, cap: null },
      )
    }
    if (!isDecimalBaseUnits(cap)) {
      return deny(
        'AMOUNT_INVALID',
        `configured cap for asset '${req.assetId}' is not a base-unit decimal string`,
        { asset: req.assetId, cap },
      )
    }
    if (req.assetAmount == null) {
      return deny(
        'AMOUNT_UNKNOWN',
        `'swap' amount for asset '${req.assetId}' is unknown but a cap is set`,
        { asset: req.assetId, cap },
      )
    }
    if (BigInt(req.assetAmount) > BigInt(cap)) {
      return deny(
        'AMOUNT_OVER_GLOBAL_LIMIT',
        `amount ${req.assetAmount} of asset '${req.assetId}' exceeds global limit ${cap}`,
        { asset: req.assetId, amount: req.assetAmount, cap },
      )
    }
  } else if (policy.maxAmountSat != null && AMOUNT_OPS.has(req.operation)) {
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
  if (grant.maxAmountSat != null && AMOUNT_OPS.has(req.operation)) {
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

/** Throwing wrapper for imperative call sites (e.g. ProtocolManager). No-op when policy is undefined. */
export function enforcePolicy(req: PolicyRequest, policy?: SigningPolicy): void {
  if (!policy) return
  const d = evaluatePolicy(req, policy)
  if (!d.allowed) {
    throw new PolicyError(d.code, `Policy denied '${req.operation}': ${d.reason}`, d.details)
  }
}
