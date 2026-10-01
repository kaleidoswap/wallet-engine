/**
 * Arkade Protocol Types
 * Ported from rate-extension/src/protocols/types/arkade.ts
 */

import { BaseProtocolConfig } from '../adapters/IProtocolAdapter'

export interface ArkadeConfig extends Omit<BaseProtocolConfig, 'network'> {
  protocol: 'ARKADE'
  mnemonic: string
  arkServerUrl: string
  esploraUrl?: string
  network?: 'mainnet' | 'signet'
  delegatorUrl?: string
  delegationEnabled?: boolean
  vtxoThresholdSeconds?: number
  /**
   * Receive-address model. 'static' (default) pins a single key at index 0; 'hd'
   * rotates across `…/0/N` and runs a gap-limit restore scan. HD requires a BIP39
   * mnemonic; nsec/hex secrets stay single-key.
   */
  walletMode?: 'static' | 'hd'
  /**
   * Start the Boltz swaps client on connect. Off by default: the client opens a
   * WebSocket to the Boltz Ark endpoint and reconnects for the life of the
   * session, which is pure background noise for a host that reaches Lightning
   * some other way. Set it only when you call into `arkadeSwapsClientManager`.
   */
  boltzSwapsEnabled?: boolean
  /**
   * `EventSource` implementation for runtimes that lack the global.
   *
   * The Arkade SDK needs the server's event stream to complete a `settle()`,
   * not just to observe one, so on a runtime without `EventSource` no VTXO is
   * ever renewed and the server sweeps them at batch expiry. Browsers and React
   * Native have the global; Node has it only behind `--experimental-eventsource`.
   * Pass one here (`eventsource` from npm, `undici`'s, your own) and the adapter
   * installs it globally, which is where the SDK looks.
   */
  eventSource?: unknown
}

export interface ArkadeVtxo {
  txid: string
  vout: number
  amount: bigint
  expiresAt?: number
  status?: 'confirmed' | 'preconfirmed' | 'recoverable'
}

export interface ArkadeBalance {
  total: bigint
  available: bigint
  preconfirmed: bigint
  settled: bigint
  recoverable: bigint
  boarding: {
    total: bigint
  }
}

export interface ArkadeTransaction {
  type: 'send' | 'receive' | 'boarding' | 'offboard'
  amount: number
  txid?: string
  timestamp?: number
  status?: string
}
