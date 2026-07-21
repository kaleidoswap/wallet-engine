/**
 * Signing / spend policy
 * ----------------------
 * A pure, portable gate for fund-moving and signing operations. It centralizes
 * the checks that would otherwise be scattered across adapters and hosts:
 * per-transaction spend limits, destination allowlists, and per-app capability
 * grants (which app/deep-link/MCP-tool may do what).
 *
 * `evaluatePolicy` is a pure function (no I/O, no globals) so it is trivially
 * testable and maps cleanly to a native (Rust/Kotlin/Swift) port. Hosts wire it
 * in via `ProtocolManager` (opt-in: no policy ⇒ no enforcement) or call it
 * directly at their own boundary.
 *
 * Design: DEFAULT-ALLOW. A policy only ever *tightens* behaviour — with no
 * policy set the engine behaves exactly as before. `mode: 'deny'` flips to
 * default-deny, where an explicit matching grant is required to proceed.
 */

import type { ProtocolType } from '../types/base'
import { classifyDestination, type DestinationKind } from '../router/destination'

/** Fund-moving / signing operations a policy can gate. */
export type PolicyOperation = 'send' | 'keysend' | 'signPsbt' | 'signMessage' | 'swap'

export interface PolicyRequest {
  operation: PolicyOperation
  /** Protocol the operation runs on (the active adapter). */
  protocol?: ProtocolType
  /** Amount in satoshis for send/keysend/swap. Omitted when not known/applicable. */
  amountSat?: number
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
  /** Per-app capability grants, resolved by `PolicyRequest.grantId`. */
  grants?: CapabilityGrant[]
}

export type PolicyDecision = { allowed: true } | { allowed: false; code: string; reason: string }

export class PolicyError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PolicyError'
    this.code = code
  }
}

const AMOUNT_OPS: ReadonlySet<PolicyOperation> = new Set(['send', 'keysend', 'swap'])

function deny(code: string, reason: string): PolicyDecision {
  return { allowed: false, code, reason }
}

/**
 * Evaluate a request against a policy. Pure — same input, same output, no I/O.
 */
export function evaluatePolicy(req: PolicyRequest, policy: SigningPolicy): PolicyDecision {
  // 1. Global per-transaction cap (applies regardless of grants/mode). When a
  // cap is configured for an amount-op but the amount is unknown, fail CLOSED:
  // an unknown amount must never slip past a spend limit (e.g. an amountless
  // BOLT11 whose value the caller never resolved).
  if (policy.maxAmountSat != null && AMOUNT_OPS.has(req.operation)) {
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
  if (req.destination != null && (grant.destinationAllowlist || grant.allowedDestinationKinds)) {
    if (grant.destinationAllowlist && !grant.destinationAllowlist.includes(req.destination)) {
      return deny('DEST_NOT_ALLOWLISTED', `destination not in grant '${grant.id}' allowlist`)
    }
    if (grant.allowedDestinationKinds) {
      const kind = classifyDestination(req.destination).kind
      if (!grant.allowedDestinationKinds.includes(kind)) {
        return deny('DEST_KIND_NOT_ALLOWED', `destination kind '${kind}' not allowed by grant '${grant.id}'`)
      }
    }
  }
  return { allowed: true }
}

/** Throwing wrapper for imperative call sites (e.g. ProtocolManager). No-op when policy is undefined. */
export function enforcePolicy(req: PolicyRequest, policy?: SigningPolicy): void {
  if (!policy) return
  const d = evaluatePolicy(req, policy)
  if (!d.allowed) throw new PolicyError(d.code, `Policy denied '${req.operation}': ${d.reason}`)
}
