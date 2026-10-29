/** Prevent singleton clients from crossing wallet identities or teardown generations. */

import { log } from './log'
import { ErrorCode, ProtocolError, type ProtocolType } from '../types/base'

/** How a different wallet is handled while another initialization is pending. */
export type WalletConflictPolicy = 'supersede' | 'reject'

export interface WalletSessionGuardOptions {
  /** Log-line prefix, e.g. `[SparkClientManager]`. */
  readonly name: string
  /** Wallet-key equality; defaults to `Object.is`. */
  readonly sameWallet?: (a: unknown, b: unknown) => boolean
  /** Conflict policy. Defaults to `supersede`. */
  readonly onConflict?: WalletConflictPolicy
  /** Error thrown by the `reject` policy. Required when `onConflict: 'reject'`. */
  readonly conflictError?: () => Error
}

/** One guarded resource's in-flight attempt. */
interface Slot {
  readonly name: string
  /** Assigned immediately after `run()` is invoked; null only during its sync prefix. */
  promise: Promise<unknown> | null
  /** The wallet this attempt is for. Recorded BEFORE the client exists — the N1 seam. */
  readonly key: unknown
  /** Generation this attempt belongs to. Advanced by `mark()`. */
  generation: number
}

/** One initialization attempt's ownership view across awaits. */
export class SessionAttempt {
  private captured: number

  /** @internal — constructed by `WalletSessionGuard.begin`. */
  constructor(
    private readonly guard: WalletSessionGuard,
    private readonly slot: Slot | null,
  ) {
    this.captured = guard.generation
  }

  /** Re-mark ownership after initialization performs its own teardown. */
  mark(): void {
    this.captured = this.guard.generation
    if (this.slot) {
      this.slot.generation = this.captured
      // Own teardown drops the slot; reclaim it unless a newer attempt won.
      this.guard.reclaim(this.slot)
    }
  }

  /** True while no teardown or wallet switch has superseded this attempt. */
  get isCurrent(): boolean {
    return this.captured === this.guard.generation
  }

  /** Refuse stale installs and dispose the client built for the lost session. */
  async claim(disposeOrphan?: () => unknown | Promise<unknown>): Promise<boolean> {
    if (this.isCurrent) return true
    log.info(`${this.guard.label} Init superseded by teardown — discarding client`)
    if (disposeOrphan) {
      try {
        await disposeOrphan()
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        log.warn(`${this.guard.label} Error cleaning up superseded client:`, msg)
      }
    }
    return false
  }
}

export class WalletSessionGuard {
  /** Teardown generation captured by each pending attempt. */
  private _generation = 0
  private readonly slots = new Map<string, Slot>()
  private readonly sameWallet: (a: unknown, b: unknown) => boolean
  private readonly onConflict: WalletConflictPolicy
  private readonly conflictError?: () => Error

  readonly label: string

  constructor(options: WalletSessionGuardOptions) {
    this.label = `[${options.name}]`
    this.sameWallet = options.sameWallet ?? Object.is
    this.onConflict = options.onConflict ?? 'supersede'
    this.conflictError = options.conflictError
    if (this.onConflict === 'reject' && !this.conflictError) {
      throw new Error('WalletSessionGuard: onConflict "reject" requires conflictError')
    }
  }

  get generation(): number {
    return this._generation
  }

  /** @internal — re-establish a slot dropped by the attempt's own teardown. */
  reclaim(slot: Slot): void {
    if (!this.slots.has(slot.name)) this.slots.set(slot.name, slot)
  }

  /** Supersede pending installs and let post-teardown callers start fresh. */
  invalidate(): void {
    this._generation++
    this.slots.clear()
  }

  /** Run or share initialization for one wallet key; never pass the raw secret. */
  begin<T>(slotName: string, key: unknown, run: (attempt: SessionAttempt) => Promise<T>): Promise<T> {
    const current = this.slots.get(slotName)
    if (current?.promise) {
      if (this.sameWallet(current.key, key)) {
        // Never share a slot whose stale attempt will resolve without installing.
        if (current.generation === this._generation) return current.promise as Promise<T>
      } else if (this.onConflict === 'reject') {
        return Promise.reject(this.conflictError!())
      } else {
        // Sharing another wallet's attempt would expose its signing client.
        this.invalidate()
      }
    }

    const slot: Slot = { name: slotName, promise: null, key, generation: this._generation }
    this.slots.set(slotName, slot)
    const attempt = new SessionAttempt(this, slot)
    const promise = run(attempt).finally(() => {
      // A stale completion must not clear a newer attempt's dedupe slot.
      if (this.slots.get(slotName) === slot) this.slots.delete(slotName)
    })
    slot.promise = promise
    return promise
  }

  /** Release only the expected instance, never a later owner's live client. */
  releaseIf<T>(held: T | null | undefined, expected: T | null | undefined): boolean {
    if (!expected || held !== expected) return false
    this.invalidate()
    return true
  }
}

// ---------------------------------------------------------------------------
// Per-install ownership of a singleton signing client
// ---------------------------------------------------------------------------

/**
 * Opaque identity of ONE client install on a shared manager. A fresh token is
 * issued every time a client is installed and the current one is dropped when
 * that client is torn down or replaced, so a token is never valid twice.
 */
export type WalletSessionToken = symbol

/**
 * Binds adapter instances to the client install their own `connect()` produced.
 *
 * Several adapter instances may share one manager singleton. Without a binding,
 * an instance left behind by a later `connect()` — on another instance, or a
 * re-connect that failed — still reads as connected and sends, signs and swaps
 * through whatever wallet the singleton holds NOW. The manager issues a token
 * when it installs a client and the adapter must present that token before
 * every operation, so a superseded adapter fails closed instead.
 */
export class ClientOwnership {
  private token: WalletSessionToken | null = null
  private serial = 0

  constructor(private readonly name: string) {}

  /** Issue the token for a client installed right now, replacing any current one. */
  issue(): WalletSessionToken {
    this.token = Symbol(`${this.name}#${++this.serial}`)
    return this.token
  }

  /** Drop the current token: the installed client is gone. */
  revoke(): void {
    this.token = null
  }

  /** The token of the client installed right now, or null. */
  get current(): WalletSessionToken | null {
    return this.token
  }

  /** True only for the token of the client installed right now. */
  owns(token: WalletSessionToken | null | undefined): boolean {
    return token != null && this.token !== null && token === this.token
  }
}

/** The error an adapter throws once the singleton it bound to was replaced. */
export function sessionSupersededError(protocol: ProtocolType): ProtocolError {
  return new ProtocolError(
    `Adapter session superseded: a later connect() replaced the shared ${protocol} client. ` +
      'Reconnect this adapter before using it.',
    protocol,
    ErrorCode.SESSION_SUPERSEDED,
  )
}

/**
 * Guard for an operation on an adapter bound to a shared client. Throws
 * NOT_CONNECTED when the adapter never connected (or disconnected) and
 * SESSION_SUPERSEDED when its install was replaced.
 */
export function assertOwnedSession(
  protocol: ProtocolType,
  token: WalletSessionToken | null,
  owns: (token: WalletSessionToken | null) => boolean,
): void {
  if (owns(token)) return
  if (!token) throw new ProtocolError('Not connected', protocol, 'NOT_CONNECTED')
  throw sessionSupersededError(protocol)
}
