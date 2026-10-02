import type { BarkBalance, BarkConfig } from '../types/bark.js'

/** Domain boundary shared by browser and native Bark bindings. */
export interface BarkWalletMovement {
  id: number
  status: string
  subsystemName: string
  subsystemKind: string
  effectiveBalanceSats: number
  intendedBalanceSats: number
  offchainFeeSats: number
  createdAt: string
  completedAt?: string
  paymentHash?: string
  lightningInvoice?: string
  sentToAddresses: string[]
  receivedOnAddresses: string[]
  inputVtxoIds: string[]
  outputVtxoIds: string[]
}

export type BarkLightningStatus =
  | { type: 'unknown' }
  | { type: 'paid'; payment_hash: string; preimage: string }
  | { type: 'inProgress'; send: { amountSats: number; feeSats: number } }

export interface BarkWalletPort {
  balance(): Promise<BarkBalance>
  properties(): Promise<{ network: string; fingerprint: string }>
  arkInfo(): Promise<{
    serverPubkey: string; minBoardAmountSats: number; requiredBoardConfirmations: number
    roundIntervalSecs: number; vtxoLifetime: number
  } | undefined>
  history(): Promise<BarkWalletMovement[]>
  sync(): Promise<unknown>
  newAddress(): Promise<string>
  bolt11Invoice(request: { amountSats: number; description?: string }): Promise<{
    invoice: string; paymentHash: string; amountSats: number
  }>
  payLightningInvoice(request: { invoice: string; amountSats?: number; wait: boolean }): Promise<BarkLightningStatus>
  /** BOLT12: fetches the offer's invoice and pays it. Backends without offer support omit it. */
  payLightningOffer?(request: { offer: string; amountSats?: number; wait: boolean }): Promise<BarkLightningStatus>
  lightningSendState(hash: string): Promise<BarkLightningStatus>
  lightningReceiveState(hash: string): Promise<{ state: string; amountSats?: number; settledAt?: number }>
  sendArkoorPayment(address: string, amount: number): Promise<void>
  sendOnchain(address: string, amount: number): Promise<string>
  broadcastTx(hex: string): Promise<string>
  boardFundingAddress(): Promise<{ address: string; expiryHeight: number; keypairIndex: number }>
  boardAmount(amount: number): Promise<object>
  boardAll(): Promise<object>
  pendingBoards(): Promise<object[]>
}

export interface BarkClient {
  initialize(config: BarkConfig): Promise<void>
  dispose(): Promise<void>
  isInitialized(): boolean
  isBarkAddress(address: string): boolean
  getWallet(): BarkWalletPort
}
