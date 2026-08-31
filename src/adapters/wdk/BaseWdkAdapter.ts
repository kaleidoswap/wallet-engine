/**
 * BaseWdkAdapter
 * --------------
 * Shared base for the WDK-backed adapters. Every one wraps a lazily-loaded
 * `manager` + `account` pair and repeats the same connection bookkeeping, so this
 * class owns that once.
 *
 * It deliberately does NOT implement the data methods — those differ per protocol.
 * It provides the connection lifecycle, the connected-guard, the swap-capability
 * lookup, and the allowlisted escape hatch; subclasses set
 * `this.manager`/`this.account`/`this.connected` in their own `connect()`.
 */

import { ProtocolType, ProtocolError } from '../../types/base'
import { getCapabilities } from '../../capabilities'
import { log } from '../../lib/log'

export abstract class BaseWdkAdapter {
  abstract readonly protocolName: ProtocolType
  readonly version: string = '0.1.0-wdk'

  protected manager: any = null
  protected account: any = null
  protected connected = false
  protected network: string = 'mainnet'
  /**
   * BIP-39 mnemonic, retained by adapters that sign locally. Held here so
   * disconnect() reliably clears it — a locked wallet must not keep signing.
   */
  protected mnemonic: string | null = null

  isConnected(): boolean {
    return this.connected
  }

  /**
   * Tear down a live session before a re-connect installs a new manager/account
   * pair. Subclasses overwrite `this.manager`/`this.account` unconditionally in
   * their own `connect()`, so without this the previous pair was abandoned
   * UNDISPOSED — still holding keys, still able to sign — and for RGB-L1 two
   * wallet instances raced on the same dataDir/IndexedDB.
   *
   * `ProtocolManager.connect()` calls `adapter.connect(config)` directly and never
   * `adapter.disconnect()` (audit finding F-F6), so a wallet switch arrives here
   * with the previous wallet still live. The native client managers already
   * disconnect-then-reinit; this is that parity (audit finding G-F13).
   *
   * Call it AFTER config validation, so an invalid config cannot tear down a
   * working session.
   */
  protected async releasePreviousConnection(): Promise<void> {
    if (!this.connected && !this.account && !this.manager) return
    try {
      await this.disconnect()
    } catch (error: unknown) {
      // `disconnect()` revokes the local state synchronously before awaiting any
      // third-party teardown, so a rejection here means only that the previous
      // SDK's cleanup failed. That must not block the new connection.
      log.warn(`[${this.constructor.name}] Error tearing down the previous connection:`, error)
    }
  }

  /** Tear down the account + manager (whichever teardown hooks they expose) and reset state. */
  async disconnect(): Promise<void> {
    // Revoke local signing capability synchronously. Third-party cleanup may
    // reject or never settle; neither outcome may keep the adapter connected or
    // leave its mnemonic reachable through this instance.
    const account = this.account
    const manager = this.manager
    this.account = null
    this.manager = null
    this.connected = false
    this.mnemonic = null

    const results = await Promise.allSettled([
      Promise.resolve().then(() => account?.dispose?.()),
      Promise.resolve().then(() => account?.cleanupConnections?.()),
      Promise.resolve().then(() => manager?.dispose?.()),
    ])
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  }

  /** Native swap capability, read from the capability manifest. */
  supportsSwaps(): boolean {
    return getCapabilities(this.protocolName).supportsSwaps
  }

  protected assertConnected(): void {
    if (!this.connected || !this.account) {
      throw new ProtocolError(`${this.constructor.name} not connected`, this.protocolName, 'NOT_CONNECTED')
    }
  }

  /**
   * Dispatch a caller-supplied operation to the account ONLY if allowlisted.
   * `operation` may be caller-influenced (deep links, chat/MCP args), so it never
   * indexes the account directly — blocking meta members (`constructor`,
   * `__proto__`, prototype methods) and any non-whitelisted method.
   */
  protected async runAllowlistedOp(
    allowed: ReadonlySet<string>,
    operation: string,
    params: unknown
  ): Promise<unknown> {
    this.assertConnected()
    if (!allowed.has(operation)) {
      throw new ProtocolError(`${this.protocolName} operation not allowed: '${operation}'`, this.protocolName, 'NO_OP')
    }
    const fn = (this.account as any)[operation]
    if (typeof fn !== 'function') {
      throw new ProtocolError(`Unknown ${this.protocolName} operation '${operation}'`, this.protocolName, 'NO_OP')
    }
    return fn.call(this.account, params)
  }
}
