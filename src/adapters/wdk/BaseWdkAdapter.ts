/**
 * BaseWdkAdapter
 * --------------
 * Shared base for the WDK-backed adapters (Spark, Liquid, RGB/RLN, RGB-L1,
 * Arkade). Every WDK adapter wraps a lazily-loaded `manager` + `account` pair
 * and repeats the same connection bookkeeping; this class owns that once so the
 * adapters only implement what's genuinely protocol-specific.
 *
 * It deliberately does NOT implement the data methods (listAssets, sendPayment,
 * …) — those differ per protocol. It only provides the connection lifecycle,
 * the connected-guard, the swap-capability lookup, and the allowlisted escape
 * hatch. Subclasses set `this.manager`/`this.account`/`this.connected` in their
 * own `connect()`.
 *
 * The native (non-WDK) adapters are intentionally left untouched.
 */

import { ProtocolType, ProtocolError } from '../../types/base'
import { getCapabilities } from '../../capabilities'

export abstract class BaseWdkAdapter {
  abstract readonly protocolName: ProtocolType
  readonly version: string = '0.1.0-wdk'

  protected manager: any = null
  protected account: any = null
  protected connected = false
  protected network: string = 'mainnet'
  /**
   * BIP-39 mnemonic, retained by adapters that sign messages/PSBTs locally.
   * Held here so disconnect() reliably clears it — a locked wallet must not
   * be able to keep signing.
   */
  protected mnemonic: string | null = null

  isConnected(): boolean {
    return this.connected
  }

  /** Tear down the account + manager (whichever teardown hooks they expose) and reset state. */
  async disconnect(): Promise<void> {
    try {
      await this.account?.dispose?.()
      await this.account?.cleanupConnections?.()
      await this.manager?.dispose?.()
    } finally {
      this.account = null
      this.manager = null
      this.connected = false
      this.mnemonic = null
    }
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
   * Dispatch a caller-supplied operation to the account ONLY if it is on the
   * adapter's allowlist. `operation` may be influenced by callers (deep links,
   * chat/MCP tool args), so it is never used to index the account directly —
   * this blocks reaching meta members (`constructor`, `__proto__`, prototype
   * methods) or any non-whitelisted method.
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
