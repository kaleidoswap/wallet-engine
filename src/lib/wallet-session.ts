/**
 * wallet-session
 * --------------
 * The wallet-identity / generation guard that every singleton client manager in
 * this package needs, in ONE place.
 *
 * WHY THIS EXISTS
 *
 * `SparkClientManager`, `ArkadeClientManager`, `ArkadeSwapsClientManager` and
 * `FlashnetClientManager` are module-level singletons that each own one live,
 * signing-capable client built from one wallet's key material. Each of them had
 * hand-rolled the same guard, and each missed a different seam — four of the five
 * concurrency findings in the second audit pass were the same bug in a different
 * singleton (A1/A2, A7, N1, N4, A-F3, A-F8/N5). The harm is always one of two
 * shapes:
 *
 *   RESURRECTION — a host locks the wallet, teardown completes, then an SDK
 *   handshake that was already in flight resolves and installs its client. The
 *   "locked" wallet is live and signing again, and a config carrying the mnemonic
 *   comes back with it.
 *
 *   CROSS-WALLET LEAK — wallet B's session is served a client built for wallet A,
 *   so B's operations sign with, and spend, A's funds. The seam every hand-rolled
 *   version got wrong (finding N1) is the IN-FLIGHT one: a manager that only
 *   compares identity against an already-BUILT client skips the check entirely
 *   while the client is still null, and hands A's pending promise to B's caller.
 *
 * WHAT THIS GUARD OWNS
 *
 * The bookkeeping, and only the bookkeeping — a generation counter plus one
 * in-flight slot per guarded resource. It does not know how to build, install or
 * dispose a client; each manager keeps that. Concretely it enforces:
 *
 *   S1  identity is compared before an already-resolved in-flight promise is
 *       reused (`begin` shares a slot only for the same wallet key);
 *   S2  identity is compared before an IN-FLIGHT promise is shared with a
 *       different wallet's caller — the N1 seam — because the slot records the
 *       key from the moment the attempt starts, not from when the client lands;
 *   S3  a generation counter that an attempt captures and re-reads AFTER its
 *       await, so a superseded attempt refuses to install (`claim`);
 *   S4  the orphaned client of a superseded attempt is disposed, not dropped
 *       (`claim`'s callback);
 *   S5  teardown invalidates every in-flight attempt, so a handshake that
 *       outlives its session cannot install itself afterwards (`invalidate`);
 *   S6  instance-scoped release that no-ops unless the singleton still holds
 *       exactly the caller's instance (`releaseIf`, the A5 shape).
 *
 * WHAT A FIFTH SINGLETON MUST DO
 *
 *   1. hold `private readonly session = new WalletSessionGuard({ name, … })`;
 *   2. route `initialize()` through `session.begin(SLOT, walletKey, run)`, where
 *      `walletKey` identifies the wallet — an SDK wallet instance, or a value
 *      `sameWallet` can compare. Never the raw secret;
 *   3. in `run`, call `attempt.mark()` at the point the session properly begins
 *      (AFTER any teardown the init performs itself), and gate the install on
 *      `await attempt.claim(() => disposeTheOrphan())`, returning early when it
 *      is false;
 *   4. in `run`'s catch, clear state only `if (attempt.isCurrent)` — a stale
 *      failure must not tear down a newer, successful session;
 *   5. call `session.invalidate()` from EVERY teardown (`disconnect`, `reset`,
 *      `dispose`), and from any wallet-switch branch that discards a built
 *      client;
 *   6. use `session.releaseIf(held, expected)` for instance-scoped release.
 *
 * A guard may own several slots (Spark guards its wallet handshake and its
 * readonly-client build) — they share one generation, so any teardown
 * invalidates both.
 */

import { log } from './log'

/**
 * What `begin()` does when it is called for a DIFFERENT wallet while an attempt
 * for another one is still in flight.
 *
 *  - `supersede` — invalidate the in-flight attempt (its `claim()` then fails and
 *    disposes its orphan) and start a fresh attempt for the caller. The wallet
 *    switch wins.
 *  - `reject` — refuse the caller and leave the in-flight attempt running. More
 *    conservative and less available: the caller must tear down first. This is
 *    `ArkadeClientManager`'s historical behaviour and is kept so that adopting
 *    the guard does not silently loosen it.
 *
 * Both are safe against the cross-wallet leak; they differ only in who loses.
 */
export type WalletConflictPolicy = 'supersede' | 'reject'

export interface WalletSessionGuardOptions {
  /** Log-line prefix, e.g. `[SparkClientManager]`. */
  readonly name: string
  /**
   * Do two wallet keys denote the same wallet? Defaults to `Object.is`, which is
   * correct both for a guard keyed by a live SDK wallet instance and for one
   * keyed by a hashed string. A guard keyed by a config object supplies a field
   * comparison.
   */
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

/**
 * One `initialize()` attempt's view of the session. Handed to the manager's init
 * body so it can ask "do I still own this session?" across its awaits.
 */
export class SessionAttempt {
  private captured: number

  /** @internal — constructed by `WalletSessionGuard.begin`. */
  constructor(
    private readonly guard: WalletSessionGuard,
    private readonly slot: Slot | null,
  ) {
    this.captured = guard.generation
  }

  /**
   * Declare that this attempt's session starts HERE.
   *
   * Call it after any teardown the init performs itself (the `if (this.client)
   * await this.disconnect()` re-init branch) — that teardown bumps the
   * generation, and without re-marking the attempt would immediately consider
   * itself superseded by its own work.
   *
   * Re-marking also moves the slot forward, so a concurrent caller for the SAME
   * wallet still shares this attempt rather than starting a second handshake.
   */
  mark(): void {
    this.captured = this.guard.generation
    if (this.slot) {
      this.slot.generation = this.captured
      // A re-init whose own `await this.disconnect()` ran above has just dropped
      // this attempt's slot. Re-establish it (only if nothing newer took the
      // name) so a concurrent caller for the SAME wallet still shares this
      // handshake instead of starting a second one against the same wallet.
      this.guard.reclaim(this.slot)
    }
  }

  /** True while no teardown or wallet switch has superseded this attempt. */
  get isCurrent(): boolean {
    return this.captured === this.guard.generation
  }

  /**
   * Ask permission to install. Returns true when this attempt still owns the
   * session; the caller may then assign its client.
   *
   * Returns false when a teardown, reset or wallet switch landed while the
   * handshake was pending. The caller must install NOTHING and return — the
   * built client is an orphan, and `disposeOrphan` is awaited here so it does
   * not sit holding sockets, subscriptions or poll loops for the process's life.
   */
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
  /**
   * Bumped by every teardown and by every wallet switch that discards a client.
   * An attempt captures it and re-reads it after its await; a mismatch means the
   * session it was building for is gone.
   */
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

  /**
   * Invalidate the session: every in-flight attempt is superseded and will
   * refuse to install. Call from EVERY teardown path (`disconnect`, `reset`,
   * `dispose`) and from any branch that discards a built client on a wallet
   * switch.
   *
   * The in-flight slots are dropped too, so no later caller is served — or
   * rejected by — an attempt belonging to a session that no longer exists. That
   * does NOT weaken the teardown: the dropped attempt still holds a stale
   * generation, so its `claim()` fails and it installs nothing. What it does mean
   * is that a caller who explicitly asks to connect AFTER a teardown gets a
   * fresh handshake that succeeds, rather than silently inheriting the doomed one
   * and believing it connected.
   */
  invalidate(): void {
    this._generation++
    this.slots.clear()
  }

  /**
   * Run, or share, an attempt to initialize the resource named `slotName` for
   * the wallet `key` identifies.
   *
   * `key` must identify the WALLET, and is recorded before the client exists —
   * that is what closes the N1 seam. Never pass a raw secret; pass the SDK wallet
   * instance, a config, or a hash.
   *
   * `run` receives a `SessionAttempt` and must use `mark()` / `claim()` /
   * `isCurrent` as described in this module's header.
   */
  begin<T>(slotName: string, key: unknown, run: (attempt: SessionAttempt) => Promise<T>): Promise<T> {
    const current = this.slots.get(slotName)
    if (current?.promise) {
      if (this.sameWallet(current.key, key)) {
        // Same wallet, same session → share the one handshake, as before. A slot
        // left behind by a superseded generation is NOT shared: it will resolve
        // without installing, so a caller handed it would believe it connected.
        if (current.generation === this._generation) return current.promise as Promise<T>
      } else if (this.onConflict === 'reject') {
        return Promise.reject(this.conflictError!())
      } else {
        // A different wallet's attempt is in flight. Returning it would put this
        // caller's session on the other wallet's client and spend its funds
        // (finding N1). Invalidate it — `claim()` will discard and dispose its
        // orphan — and build for the wallet we were actually given.
        this.invalidate()
      }
    }

    const slot: Slot = { name: slotName, promise: null, key, generation: this._generation }
    this.slots.set(slotName, slot)
    const attempt = new SessionAttempt(this, slot)
    const promise = run(attempt).finally(() => {
      // Only the newest attempt clears the slot; an older one settling later must
      // not wipe a newer in-flight attempt's dedupe.
      if (this.slots.get(slotName) === slot) this.slots.delete(slotName)
    })
    slot.promise = promise
    return promise
  }

  /**
   * Instance-scoped release — the A5 shape.
   *
   * Returns true, and invalidates the session, only when the singleton still
   * holds exactly `expected`. Another owner may have installed its own instance
   * in the meantime, and dropping a live client that is not the caller's would
   * be a worse bug than the one this closes.
   */
  releaseIf<T>(held: T | null | undefined, expected: T | null | undefined): boolean {
    if (!expected || held !== expected) return false
    this.invalidate()
    return true
  }
}
