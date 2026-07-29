/** Experimental Liquid Simplicity/PSET contract. No LWK objects cross this boundary. */

export type SimplicityArgument =
  | { name: string; type: 'u8' | 'u16' | 'u32'; value: number }
  | { name: string; type: 'u64'; value: string | number | bigint }
  | { name: string; type: 'u128' | 'u256' | 'bytes'; value: string }
  | { name: string; type: 'bool'; value: boolean }

export interface SimplicityCapabilities {
  version: 'experimental-0.1'
  available: boolean
  pset: { inspect: boolean; blind: boolean; sign: boolean; finalize: boolean }
  simplicity: { compile: boolean; derivePublicKey: boolean; finalizeTransaction: boolean }
}

export interface LiquidPsetReview {
  pset: string
  uniqueId: string
  inputCount: number
  outputCount: number
  inputs: Array<{ index: number; txid: string; vout: number; sighash: number; issuanceAsset?: string; issuanceToken?: string }>
  outputs: Array<{ index: number; scriptPubKey: string; amount?: string; assetId?: string; blinderIndex?: number }>
  fee: string
  balances: Array<{ assetId: string; amount: string }>
  recipients: Array<{ vout: number; address?: string; assetId?: string; amount?: string }>
  issuances: Array<{
    inputIndex: number
    type: 'issuance' | 'reissuance' | 'none'
    assetId?: string
    tokenId?: string
    previousTxid?: string
    previousVout?: number
  }>
  signatures: Array<{ inputIndex: number; present: number; missing: number }>
}

export interface LiquidPsetSignRequest {
  pset: string
  /** Restricts which inputs may receive new signatures. The operation fails closed on violation. */
  inputIndexes?: number[]
}

export interface LiquidPsetSignResult {
  pset: string
  signedInputIndexes: number[]
  unchanged: boolean
}

export interface SimplicityCompileRequest {
  source: string
  arguments?: SimplicityArgument[]
  /** Defaults to the unspendable NUMS key used by the Humid manifest draft. */
  internalKey?: string
  derivationPath?: string
}

export interface SimplicityCompileResult {
  cmr: string
  address: string
  internalKey: string
  walletPublicKey: string
  derivationPath: string
}
