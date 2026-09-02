/** Shared connection lifecycle for WDK-backed adapters. */

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

  /** Release retained keys before replacing a live session; validate config first. */
  protected async releasePreviousConnection(): Promise<void> {
    if (!this.connected && !this.account && !this.manager) return
    try {
      await this.disconnect()
    } catch (error: unknown) {
      // Local signing state is already revoked, so SDK cleanup cannot block reconnect.
      log.warn(`[${this.constructor.name}] Error tearing down the previous connection:`, error)
    }
  }

  /** Tear down the account + manager (whichever teardown hooks they expose) and reset state. */
  async disconnect(): Promise<void> {
    // Revoke local signing state before awaiting fallible third-party cleanup.
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

  /** Dispatch caller-influenced operations only through an explicit allowlist. */
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
