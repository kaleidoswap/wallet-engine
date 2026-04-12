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
