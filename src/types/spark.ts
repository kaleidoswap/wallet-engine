/**
 * Spark Protocol Types
 * Ported from rate-extension/src/protocols/types/spark.ts
 */

import { BaseProtocolConfig } from '../adapters/IProtocolAdapter'

export interface SparkConfig extends Omit<BaseProtocolConfig, 'network'> {
  protocol: 'SPARK'
  mnemonic: string
  network?: 'mainnet' | 'testnet' | 'regtest' | 'signet'
}

export type SparkTransferDirection = 'INCOMING' | 'OUTGOING' | string

export type SparkTransferStatus =
  | 'TRANSFER_STATUS_SENDER_INITIATED'
  | 'TRANSFER_STATUS_RECEIVER_KEY_TWEAKED'
  | 'TRANSFER_STATUS_COMPLETED'
  | 'TRANSFER_STATUS_RETURNED'
  | 'TRANSFER_STATUS_EXPIRED'
  | string

export interface SparkTransfer {
  id: string
  senderIdentityPublicKey: string
  receiverIdentityPublicKey: string
  status: SparkTransferStatus
  totalValue: number
  expiryTime: Date | undefined
  createdTime: Date | undefined
  updatedTime: Date | undefined
  type: string
  transferDirection: SparkTransferDirection
  sparkInvoice: string | undefined
}

export interface SparkLightningInvoice {
  id: string
  invoice: {
    encodedInvoice: string
    paymentHash: string
    amountSats?: number
    memo?: string
    expiryTime?: Date
  }
  status: string
  createdTime?: Date
}

export interface SparkLightningSend {
  id: string
  invoice: string
  amountSats: number
  feeSats?: number
  status: string
  createdTime?: Date
}

export interface SparkNodeInfo {
  id: string
  balanceMsat: number
  inboundLiquidityMsats: number
  onchainBalanceMsat: number
  maxPayableMsat: number
  maxReceivableMsat: number
  connectedPeers: string[]
  blockHeight: number
  channelsBalanceMsat: number
  pendingOnchainBalanceMsat: number
  utxos: number
}
