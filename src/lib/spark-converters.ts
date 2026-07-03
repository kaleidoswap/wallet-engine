/**
 * SDK ↔ unified-shape converters for the Spark adapter.
 *
 * The three converters here cover the three sources of Spark activity:
 *
 *  - `convertTransferToTransaction`     — native Spark transfer
 *  - `convertTokenTransactionToUnified` — RGB-Spark token transaction
 *    (with direction-inference from output ownership)
 *  - `buildSentRecordTransaction`       — offline fallback from the
 *    locally-stored send-token outbox
 */

import { encodeBech32mTokenIdentifier } from '@buildonspark/spark-sdk'
import type { TransactionStatus, UnifiedAsset, UnifiedTransaction } from '../types/base'
import type { SparkTransfer } from '../types/spark'
import type { SentTokenTxRecord } from './spark-sent-token-records'
import { normalizeTxHash } from './spark-sent-token-records'
import {
  formatAmount,
  mapTransferStatus,
  rawTokenIdFromBytes,
  tokenRefsMatch,
  txHashFromBytes,
  u8aToBigInt,
  u8aToHex,
} from './spark-helpers'

const BTC_ASSET: UnifiedAsset = {
  id: 'BTC',
  name: 'Bitcoin',
  ticker: 'BTC',
  precision: 8,
  protocol: 'SPARK',
  layer: 'SPARK_SPARK',
} as UnifiedAsset

/**
 * Project a native Spark transfer into the unified shape. BTC is the only
 * native Spark asset, so the asset is hard-coded — this branch never
 * surfaces RGB-Spark token transfers (see `convertTokenTransactionToUnified`).
 */
export function convertTransferToTransaction(transfer: SparkTransfer): UnifiedTransaction {
  const isIncoming = transfer.transferDirection === 'INCOMING'
  return {
    id: transfer.id,
    type: isIncoming ? 'receive' : 'send',
    status: mapTransferStatus(transfer.status),
    timestamp: transfer.createdTime?.getTime() ?? Date.now(),
    amount: transfer.totalValue,
    amountDisplay: formatAmount(transfer.totalValue, 8),
    fee: 0,
    feeDisplay: '0.00000000',
    asset: BTC_ASSET,
    protocolData: {
      sparkInvoice: transfer.sparkInvoice,
      type: transfer.type,
    },
  }
}

/**
 * Convert a TokenTransactionWithStatus from the Spark SDK into a
 * UnifiedTransaction.
 *
 * Direction: mints/creates are always receives. For transfers the protocol
 * exposes no direction field, so we derive it from output ownership — the
 * SDK orders token outputs recipients-first, change-last, so a wallet-owned
 * first output (`tokenOutputs[0]`) means the wallet was the recipient
 * (receive); anything else means it sent. A hash in `sentHashSet` (our
 * local outbox) overrides this as an authoritative "send" — it covers the
 * rare batch transfer where the wallet is a non-first recipient.
 *
 * Amount: receives sum the wallet-owned outputs; sends sum the outputs that
 * left the wallet (everything not wallet-owned), falling back to the
 * recorded amount when the gateway returns no figure.
 */
export function convertTokenTransactionToUnified(
  txWithStatus: {
    tokenTransaction?: unknown
    status: number
    tokenTransactionHash: Uint8Array
  },
  walletIdentityPubKey: string,
  tokenMetaMap: Map<string, { name: string; ticker: string; decimals: number }>,
  rawTokenMetaMap: Map<
    string,
    { id: string; meta: { name: string; ticker: string; decimals: number } }
  >,
  sentHashSet: Set<string>,
  storedRecordMap: Map<string, SentTokenTxRecord>,
  storedAmountMap: Map<string, bigint>,
  networkType: string,
  requestedAsset?: string,
  requestedTokenRawId?: string,
): UnifiedTransaction | null {
  const tx = txWithStatus.tokenTransaction as
    | {
        tokenOutputs?: Array<{
          ownerPublicKey: Uint8Array
          tokenIdentifier?: Uint8Array
          tokenAmount: Uint8Array
        }>
        tokenInputs?: { $case?: string }
        clientCreatedTimestamp?: Date | number
      }
    | undefined
  if (!tx) return null

  const outputs: Array<{
    ownerPublicKey: Uint8Array
    tokenIdentifier?: Uint8Array
    tokenAmount: Uint8Array
  }> = tx.tokenOutputs ?? []
  if (outputs.length === 0) return null

  const txHash = txHashFromBytes(txWithStatus.tokenTransactionHash)

  const walletPubKeyLower = walletIdentityPubKey.toLowerCase()
  const ownsOutput = (o: { ownerPublicKey?: Uint8Array }): boolean =>
    !!o.ownerPublicKey && u8aToHex(o.ownerPublicKey).toLowerCase() === walletPubKeyLower

  // Direction: mints/creates are receives; an outbox hit is an authoritative
  // send; otherwise the first output's owner decides (see method doc).
  const inputCase = tx.tokenInputs?.$case as string | undefined
  let type: 'send' | 'receive'
  if (inputCase === 'mintInput' || inputCase === 'createInput') {
    type = 'receive'
  } else if (sentHashSet.has(txHash)) {
    type = 'send'
  } else {
    type = ownsOutput(outputs[0]) ? 'receive' : 'send'
  }
  const storedRecord = type === 'send' ? storedRecordMap.get(txHash) : undefined

  // Resolve token identity from the strongest local source available.
  const firstOutput = outputs[0]
  const tokenIdBytes = firstOutput.tokenIdentifier
  let tokenId = ''
  let meta = { name: 'Unknown Token', ticker: 'TOKEN', decimals: 0 }

  if (storedRecord?.assetId) {
    tokenId =
      requestedAsset && tokenRefsMatch(storedRecord.assetId, requestedAsset)
        ? requestedAsset
        : storedRecord.assetId
    meta = {
      name: storedRecord.name || storedRecord.assetId,
      ticker: storedRecord.ticker || 'TOKEN',
      decimals: storedRecord.decimals,
    }
  } else if (tokenIdBytes && tokenIdBytes.length > 0) {
    const rawTokenId = rawTokenIdFromBytes(tokenIdBytes)
    const rawFound = rawTokenMetaMap.get(rawTokenId)
    if (requestedAsset && requestedTokenRawId && rawTokenId === requestedTokenRawId) {
      tokenId = requestedAsset
      meta = rawFound?.meta ?? tokenMetaMap.get(requestedAsset) ?? meta
    }
    if (rawFound) {
      tokenId ||= rawFound.id
      meta = rawFound.meta
    }

    try {
      if (!tokenId) {
        tokenId = encodeBech32mTokenIdentifier({
          tokenIdentifier: tokenIdBytes,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK network enum varies by version
          network: networkType as any,
        })
      }
      const found = tokenMetaMap.get(tokenId)
      if (found) meta = found
    } catch {
      // Fallback: take first entry from map when encoding fails
      for (const [id, m] of tokenMetaMap) {
        tokenId = id
        meta = m
        break
      }
    }
  }

  if (requestedAsset && !tokenId) {
    tokenId = requestedAsset
    const found = tokenMetaMap.get(requestedAsset)
    if (found) meta = found
  }

  // Amount
  let totalAmount = 0n
  if (type === 'receive') {
    // Sum the outputs the wallet owns — its received amount — ignoring any
    // change the sender kept for itself.
    for (const o of outputs) {
      if (ownsOutput(o)) totalAmount += u8aToBigInt(o.tokenAmount)
    }
    // Fallback for mints / unexpected shapes where no output resolves as owned.
    if (totalAmount === 0n) {
      for (const o of outputs) totalAmount += u8aToBigInt(o.tokenAmount)
    }
  } else {
    // Send: the amount that left the wallet is the sum of outputs the wallet
    // does NOT own (recipients), excluding its own change output.
    for (const o of outputs) {
      if (!ownsOutput(o)) totalAmount += u8aToBigInt(o.tokenAmount)
    }
    // Fall back to the amount recorded at send time if the gateway returned
    // nothing usable (e.g. a redacted or change-less response).
    if (totalAmount === 0n) {
      totalAmount = storedAmountMap.get(txHash) ?? 0n
    }
  }

  const amount = Number(totalAmount)

  // Map token transaction status
  // TokenTransactionStatus: FINALIZED=2 → confirmed, *CANCELLED=3,4 → failed
  const statusNum = txWithStatus.status
  let status: TransactionStatus = 'pending'
  if (statusNum === 2) {
    status = 'confirmed' // TOKEN_TRANSACTION_FINALIZED
  } else if (statusNum === 3 || statusNum === 4) {
    status = 'failed' // *_CANCELLED
  }

  const rawTs = tx.clientCreatedTimestamp
  const timestamp =
    rawTs instanceof Date ? rawTs.getTime() : typeof rawTs === 'number' ? rawTs : Date.now()

  return {
    id: `token-${txHash.slice(0, 16)}`,
    type,
    status,
    timestamp,
    amount,
    amountDisplay: formatAmount(amount, meta.decimals),
    fee: 0,
    feeDisplay: '0',
    asset: {
      id: tokenId,
      name: meta.name,
      ticker: meta.ticker,
      precision: meta.decimals,
      protocol: 'SPARK',
      layer: 'SPARK_SPARK',
    } as UnifiedAsset,
    protocolData: {
      type: inputCase ?? 'unknown',
    },
  }
}

/**
 * Build a UnifiedTransaction directly from a locally-stored send record,
 * with no Spark RPC. Used as the offline / failed-fetch fallback in
 * `listTransactions` so a completed token withdrawal always appears in
 * history even when the Spark gateway is unreachable.
 *
 * Marks the transaction as `confirmed` on the rationale that the record is
 * only written after the SDK returns a tx id — i.e. the transfer was
 * signed and broadcast.
 */
export function buildSentRecordTransaction(
  record: SentTokenTxRecord,
  requestedAsset?: string,
): UnifiedTransaction {
  const decimals = record.decimals || 0
  const amount = record.amount || 0
  const tokenId =
    requestedAsset && tokenRefsMatch(record.assetId, requestedAsset)
      ? requestedAsset
      : record.assetId
  return {
    id: `token-${normalizeTxHash(record.hash).slice(0, 16)}`,
    type: 'send',
    status: 'confirmed',
    timestamp: record.timestamp || Date.now(),
    amount,
    amountDisplay: formatAmount(amount, decimals),
    fee: 0,
    feeDisplay: '0',
    asset: {
      id: tokenId,
      name: record.name || record.assetId,
      ticker: record.ticker || 'TOKEN',
      precision: decimals,
      protocol: 'SPARK',
      layer: 'SPARK_SPARK',
    } as UnifiedAsset,
    protocolData: {
      type: 'transferInput',
      source: 'local-record',
    },
  }
}
