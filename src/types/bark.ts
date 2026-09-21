/**
 * Bark Protocol Types — Second's Ark implementation (`@secondts/bark`).
 *
 * Distinct from ARKADE (`@arkade-os/sdk`): different server, different rounds,
 * no interop. Both mint `tark1…` addresses on signet, so an address alone
 * cannot tell the two apart — route by account, never by prefix.
 */

import { BaseProtocolConfig } from '../adapters/IProtocolAdapter'

export interface BarkConfig extends Omit<BaseProtocolConfig, 'network'> {
  protocol: 'BARK'
  /** BIP39 phrase; bark derives its own keys from it. */
  mnemonic: string
  /** Ark server, e.g. https://ark.signet.2nd.dev */
  arkServerUrl: string
  /** Chain source. The SDK has no default — omitting it fails at open. */
  esploraUrl?: string
  network?: 'mainnet' | 'signet'
  /**
   * IndexedDB database name. Defaults to bark's own fingerprint-derived name.
   * Set it per wallet: `Wallet.open` does NOT check the mnemonic against the
   * stored database, so two seeds sharing a name silently share state.
   */
  dbName?: string
  /**
   * Let bark run its own background loop (mailbox, round events, periodic
   * sync). Off by default here: an MV3 service worker is evicted while idle,
   * so the host drives `maintenance()`/`progressPendingRounds()` from an alarm
   * instead.
   */
  runDaemon?: boolean
  /** Skip the mailbox recovery scan on the open that creates the wallet. */
  skipRecovery?: boolean
  /** Refresh a VTXO once it is within this many blocks of expiry. */
  vtxoRefreshExpiryThreshold?: number
  /** Sent to the Ark server; defaults to the SDK's own string. */
  userAgent?: string
}

/** Subset of bark's `Balance` the engine reads. */
export interface BarkBalance {
  spendableSats: number
  pendingInRoundSats: number
  pendingExitSats: number
  pendingLightningSendSats: number
  claimableLightningReceiveSats: number
  pendingBoardSats: number
}

/** What the host's periodic lifecycle tick did. */
export interface BarkMaintenanceReport {
  syncedMs: number
  refreshed: string[]
  pendingRounds: number
  claimableExits: number
  /** Block height by which a VTXO must be refreshed, when one is due. */
  nextRequiredRefreshHeight?: number
}
