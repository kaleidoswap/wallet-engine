/*
 * Regression test for the wallet-identity guard PRIMITIVE
 * (src/lib/wallet-session.ts), extracted from the four client managers that
 * each hand-rolled it — and each missed a different seam (REPORT-2.md §4.3 q2:
 * "four of five concurrency findings this pass are the same bug in a different
 * singleton").
 *
 * The per-manager regression tests (A1/A2, A5, A7, N1, N4, A-F3, A-F8/N5) prove
 * the four managers still behave. This file proves the PRIMITIVE does — so a
 * FIFTH singleton adopting it inherits the fixes instead of re-deriving them.
 *
 * `ToySingleton` below is that fifth singleton, written the way the module
 * header tells a new manager to write one, and nothing more. Every seam is
 * exercised through it.
 */
import { describe, expect, it, vi } from 'vitest'
import { WalletSessionGuard } from '../../src/lib/wallet-session'

type Wallet = { marker: string }
type Client = { boundWallet: Wallet; disposed: boolean }

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * A fifth singleton, built on the guard exactly as src/lib/wallet-session.ts's
 * header prescribes. It knows how to build, install and dispose a client; the
 * guard owns every identity/generation decision.
 */
class ToySingleton {
  private readonly session = new WalletSessionGuard({ name: 'ToySingleton' })
  client: Client | null = null
  /** Every client ever built, so a leaked orphan is visible. */
  readonly built: Client[] = []
  /** How the test parks each in-flight handshake. */
  pending: Array<{ wallet: Wallet; resolve: (c: Client) => void; reject: (e: unknown) => void }> = []

  initialize(wallet: Wallet): Promise<void> {
    return this.session.begin('client', wallet, async (attempt) => {
      attempt.mark()
      const d = deferred<Client>()
      this.pending.push({ wallet, resolve: d.resolve, reject: d.reject })
      let client: Client
      try {
        client = await d.promise
      } catch (err) {
        if (attempt.isCurrent) this.client = null
        throw err
      }
      this.built.push(client)
      if (!(await attempt.claim(() => { client.disposed = true }))) return
      this.client = client
    })
  }

  release(wallet: Wallet): void {
    if (!this.session.releaseIf(this.client?.boundWallet, wallet)) return
    this.client = null
  }

  teardown(): void {
    this.client = null
    this.session.invalidate()
  }

  /** Resolve the parked handshake for `marker` with a client bound to it. */
  land(marker: string): void {
    const p = this.pending.find((x) => x.wallet.marker === marker)
    if (!p) throw new Error(`no pending handshake for ${marker}`)
    p.resolve({ boundWallet: p.wallet, disposed: false })
  }
}

const A: Wallet = { marker: 'A' }
const B: Wallet = { marker: 'B' }

describe('the wallet-session guard primitive', () => {
  it('S2/N1: an in-flight handshake is never shared with a DIFFERENT wallet', async () => {
    // This is the seam every hand-rolled version got wrong. While the client is
    // still being built there is nothing to compare identity against — unless
    // the guard recorded the wallet when the attempt STARTED, which it does.
    const s = new ToySingleton()

    const initA = s.initialize(A)
    await vi.waitFor(() => expect(s.pending).toHaveLength(1))

    const initB = s.initialize(B)
    expect(initB, "B's caller must not be handed A's promise").not.toBe(initA)
    await vi.waitFor(() => expect(s.pending).toHaveLength(2))

    // A's handshake lands LAST — the dangerous ordering.
    s.land('B')
    await initB
    s.land('A')
    await initA

    expect(s.client?.boundWallet.marker, "B's session must never run on A's client").toBe('B')
    // S4: A's orphan is disposed, not merely dropped.
    const orphan = s.built.find((c) => c.boundWallet.marker === 'A')
    expect(orphan?.disposed, 'the superseded client must be disposed').toBe(true)
  })

  it('S1: concurrent callers for the SAME wallet share one handshake', async () => {
    const s = new ToySingleton()
    const p1 = s.initialize(A)
    const p2 = s.initialize(A)
    expect(p1).toBe(p2)
    s.land('A')
    await p1
    expect(s.pending, 'only one handshake was started').toHaveLength(1)
    expect(s.client?.boundWallet.marker).toBe('A')
  })

  it('S3/S5: a teardown during an in-flight handshake is not undone by it', async () => {
    const s = new ToySingleton()
    const init = s.initialize(A)
    await vi.waitFor(() => expect(s.pending).toHaveLength(1))

    s.teardown()
    s.land('A')
    await init

    expect(s.client, 'a torn-down session must stay torn down').toBeNull()
    expect(s.built[0]?.disposed, 'the orphan must be disposed').toBe(true)
  })

  it('a caller who asks to connect AFTER a teardown gets a fresh, working handshake', async () => {
    // The teardown must stick against the attempt it superseded — but it must
    // not poison an explicit new connect request by handing it the doomed one.
    const s = new ToySingleton()
    const stale = s.initialize(A)
    await vi.waitFor(() => expect(s.pending).toHaveLength(1))
    s.teardown()

    const fresh = s.initialize(A)
    expect(fresh).not.toBe(stale)
    await vi.waitFor(() => expect(s.pending).toHaveLength(2))
    s.pending[1].resolve({ boundWallet: A, disposed: false })
    await fresh
    expect(s.client?.boundWallet.marker).toBe('A')

    s.pending[0].resolve({ boundWallet: A, disposed: false })
    await stale
    expect(s.client?.boundWallet.marker, 'the stale handshake must not overwrite it').toBe('A')
    expect(s.built.filter((c) => c.disposed), 'the stale client is disposed').toHaveLength(1)
  })

  it('S6: release is instance-scoped — it never drops a client that is not the caller\'s', () => {
    const s = new ToySingleton()
    s.client = { boundWallet: A, disposed: false }

    s.release(B)
    expect(s.client, 'releasing a wallet we do not hold must be a no-op').not.toBeNull()

    s.release(A)
    expect(s.client).toBeNull()
  })

  it('S6: release invalidates the session, so an in-flight handshake cannot repopulate it', async () => {
    const s = new ToySingleton()
    const init = s.initialize(A)
    await vi.waitFor(() => expect(s.pending).toHaveLength(1))
    s.client = { boundWallet: A, disposed: false }

    s.release(A)
    s.land('A')
    await init

    expect(s.client).toBeNull()
  })

  it('a failed handshake does not tear down a newer, successful one', async () => {
    const s = new ToySingleton()
    const initA = s.initialize(A)
    await vi.waitFor(() => expect(s.pending).toHaveLength(1))
    const initB = s.initialize(B)
    await vi.waitFor(() => expect(s.pending).toHaveLength(2))

    s.land('B')
    await initB
    expect(s.client?.boundWallet.marker).toBe('B')

    s.pending[0].reject(new Error('A: gateway unreachable'))
    await expect(initA).rejects.toThrow(/gateway unreachable/)
    expect(s.client?.boundWallet.marker, "A's failure must not clear B's client").toBe('B')
  })

  it('the `reject` conflict policy refuses the newcomer instead of superseding', async () => {
    // ArkadeClientManager's historical, more conservative answer. Kept as an
    // option so adopting the guard could not silently loosen it.
    const guard = new WalletSessionGuard({
      name: 'Strict',
      onConflict: 'reject',
      conflictError: () => new Error('already initializing with a different config'),
    })
    const d = deferred<void>()
    const first = guard.begin('slot', A, async (attempt) => {
      attempt.mark()
      await d.promise
    })
    await expect(guard.begin('slot', B, async () => {})).rejects.toThrow(
      /already initializing with a different config/,
    )
    d.resolve()
    await first
  })

  it('demands a conflictError when configured to reject', () => {
    expect(() => new WalletSessionGuard({ name: 'X', onConflict: 'reject' })).toThrow(
      /requires conflictError/,
    )
  })

  it('a re-init that tears down its own predecessor still dedupes same-wallet callers', async () => {
    // `mark()` is called after the init's own `await this.disconnect()`. That
    // teardown invalidates the session, so without re-establishing the slot a
    // concurrent same-wallet caller would start a SECOND handshake against the
    // same wallet.
    const guard = new WalletSessionGuard({ name: 'ReInit' })
    const d = deferred<void>()
    let started = 0
    const run = () =>
      guard.begin('slot', A, async (attempt) => {
        started++
        await Promise.resolve() // stand in for `await this.disconnect()`
        guard.invalidate() //   which invalidates the session itself
        attempt.mark()
        await d.promise
      })

    const p1 = run()
    await Promise.resolve()
    await Promise.resolve()
    const p2 = run()
    expect(p2, 'the same-wallet caller shares the re-init').toBe(p1)
    d.resolve()
    await p1
    expect(started).toBe(1)
  })
})
