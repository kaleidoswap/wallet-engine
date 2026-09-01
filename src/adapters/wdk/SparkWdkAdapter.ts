/**
 * SparkWdkAdapter
 * ---------------
 * Maps the WDK Spark module (@tetherto/wdk-wallet-spark) onto the
 * `IProtocolAdapter` contract — the reference implementation of the "wrap a WDK
 * module behind the contract" pattern (docs/WDK_INTEGRATION_PLAN.md).
 *
 * Discipline: no WDK/SDK types cross the boundary (WDK objects are held as `any`);
 * the WDK account surface is the primary path; the raw `SparkWallet`
 * (`account._wallet`) is reached ONLY for what WDK does not expose — token send +
 * outbox, token history, L1 deposit claiming, cooperative-exit withdrawal — ported
 * verbatim from the native SparkAdapter. The sub-path avoids a static
 * `@buildonspark/spark-sdk` import: address helpers are lazy-loaded in `connect()`
 * and spark-converters is dynamic-imported on demand.
 */

import { IProtocolAdapter, BaseProtocolConfig } from '../IProtocolAdapter'
import {
  ProtocolType,
  Layer,
  NodeInfo,
  UnifiedAsset,
  UnifiedTransaction,
  InvoiceRequest,
  Invoice,
  DecodedInvoice,
  PaymentRequest,
  PaymentResult,
  PaymentStatus,
  Address,
  ConnectionInfo,
  TransactionFilter,
  TransactionStatus,
  ProtocolError,
} from '../../types/base'
import { getCapabilities } from '../../capabilities'
import { PROTOCOL_OPERATIONS } from '../../capabilities/operations'
import { loadWdkModule } from './moduleLoader'
import { decodeBolt11, isBolt11 } from '../../lib/bolt11'
import { waitForLightningSendSettlement } from '../../lib/spark-lightning-settlement'
import { BaseWdkAdapter } from './BaseWdkAdapter'
import {
  formatAmount,
  mapTransferStatus,
  parseSdkExpiryMs,
  rawTokenIdFromBech32mTokenId,
  rawTokenIdFromBytes,
  tokenRefsMatch,
  txHashFromBytes,
} from '../../lib/spark-helpers'
import { getSparkBalanceCached, invalidateSparkBalanceCache } from '../../lib/spark-balance-cache'
import {
  loadSentTokenRecords,
  normalizeTxHash,
  saveSentTokenRecord,
  type SentTokenTxRecord,
} from '../../lib/spark-sent-token-records'
import { signLnMessage, verifyLnMessage } from '../../lib/ln-message-sign'
import { resolveWalletSeed } from '../../lib/wallet-seed'

/** Default maximum fee for Lightning payments (sats) — mirrors the native adapter. */
const DEFAULT_MAX_FEE_SATS = 1000

/** Lower-case hex string for a Uint8Array / Buffer / hex string (for identity-key compare). */
function toHexLower(bytes: any): string {
  if (!bytes) return ''
  if (typeof bytes === 'string') return bytes.toLowerCase()
  try {
    let out = ''
    for (const b of bytes) out += b.toString(16).padStart(2, '0')
    return out.toLowerCase()
  } catch {
    return ''
  }
}

/** Map a spark-sdk Transfer proto status → domain TransactionStatus. */
function mapSparkStatus(s?: string): TransactionStatus {
  const v = String(s ?? '').toUpperCase()
  if (v.includes('COMPLET')) return 'confirmed'
  if (v.includes('FAIL') || v.includes('EXPIRED') || v.includes('RETURN')) return 'failed'
  return 'pending'
}

function isDirectSparkTransfer(t: any): boolean {
  const type = String(t?.type ?? t?.transferType ?? t?.sparkTransactionType ?? '').toUpperCase()
  const hasUserRequest = t?.userRequest != null || t?.userRequestId != null
  const hasTransferShape =
    t?.receiverIdentityPublicKey != null || t?.senderIdentityPublicKey != null || t?.totalValue != null
  return type === 'TRANSFER' || type === '2' || (!hasUserRequest && hasTransferShape)
}

export interface SparkAdapterConfig extends BaseProtocolConfig {
  protocol: 'SPARK'
  /** BIP-39 mnemonic for this wallet. */
  mnemonic: string
  /** BIP-44 account index (default 0). */
  accountIndex?: number
}

/** Local mirror of the WDK Spark network union (kept here so WDK types never cross the contract). */
type SparkNetwork = 'MAINNET' | 'TESTNET' | 'REGTEST' | 'SIGNET' | 'LOCAL'

const SPARK_NETWORK_MAP: Record<string, SparkNetwork> = {
  mainnet: 'MAINNET',
  testnet: 'TESTNET',
  regtest: 'REGTEST',
  signet: 'SIGNET', // Spark supports SIGNET natively
}

export class SparkWdkAdapter extends BaseWdkAdapter implements IProtocolAdapter {
  readonly protocolName: ProtocolType = 'SPARK'
  readonly capabilities = PROTOCOL_OPERATIONS.SPARK
  readonly supportedLayers: Layer[] = getCapabilities('SPARK').layers

  // Cached account identity pubkey (hex) — used to derive transfer direction,
  // since the spark-sdk Transfer proto exposes sender/receiver identity keys
  // rather than an explicit direction flag.
  private identityPubKeyHex: string | null = null


  /** Lazily-loaded `@buildonspark/spark-sdk` address helpers (kept off the static import graph). */
  private sdk: any = null

  /** Maps a created Lightning invoice string → its receive-request id (for status polling). */
  private invoiceRequestIds = new Map<string, string>()

  /** The raw SparkWallet the WDK account wraps — proven surface for token/deposit/withdrawal ops. */
  private get rawWallet(): any {
    const w = (this.account as any)?._wallet
    if (!w) throw new ProtocolError('Spark wallet unavailable', 'SPARK', 'NOT_CONNECTED')
    return w
  }

  // --- Connection ---------------------------------------------------------
  async connect(config: BaseProtocolConfig): Promise<void> {
    const cfg = config as SparkAdapterConfig
    if (!cfg.mnemonic) {
      throw new ProtocolError('SparkWdkAdapter requires a mnemonic', 'SPARK', 'CONFIG')
    }
    await this.releasePreviousConnection()
    this.mnemonic = cfg.mnemonic
    this.network = cfg.network ?? 'mainnet'
    // Injectable loader (RN injects a static require; Node/Vite use the import fallback).
    // @ts-ignore — declared as a workspace/optional dep; resolved at runtime.
    const mod = await loadWdkModule('@tetherto/wdk-wallet-spark', () => import('@tetherto/wdk-wallet-spark'))
    const WalletManagerSpark = mod.default ?? mod
    // Resolve to seed bytes so nsec/hex-rooted wallets bypass the WDK base's
    // BIP-39 string validation (which throws "The seed phrase is invalid").
    this.manager = new WalletManagerSpark(resolveWalletSeed(cfg.mnemonic), {
      network: SPARK_NETWORK_MAP[this.network] ?? 'MAINNET',
    })
    this.account = await this.manager.getAccount(cfg.accountIndex ?? 0)
    try {
      this.identityPubKeyHex = toHexLower(await this.account.getIdentityKey?.()) || null
    } catch {
      this.identityPubKeyHex = null
    }
    // Lazy-load the SDK address helpers used to classify send destinations. Kept
    // out of the static import graph so this sub-path stays SDK-free until used.
    // @ts-ignore — resolved at runtime; a transitive dep of the WDK Spark module.
    this.sdk = await loadWdkModule('@buildonspark/spark-sdk', () => import('@buildonspark/spark-sdk'))
    // Back the native sparkClientManager singleton with this adapter's SparkWallet,
    // so host glue reading Spark through it (Flashnet AMM, Orchestra bridge) keeps
    // working under the WDK backend — no second wallet, no derivation drift. Lazy
    // imported so spark-client-manager never enters this sub-path's static graph.
    try {
      const { sparkClientManager } = await import('../../lib/spark-client-manager')
      sparkClientManager.adoptExternalWallet((this.account as any)?._wallet, this.network)
    } catch {
      /* flashnet/bridge glue is optional — never block connect on it */
    }
    this.connected = true
  }

  /**
   * Tear down symmetrically with `connect()`. The base implementation clears only
   * this adapter's own account/manager/mnemonic — "a locked wallet must not be
   * able to keep signing", per its doc comment — but `connect()` also handed the
   * raw SparkWallet to the `sparkClientManager` singleton. Without releasing it
   * there, the singleton keeps serving a live, signing-capable wallet long after
   * the adapter reports disconnected.
   */
  async disconnect(): Promise<void> {
    const adopted = (this.account as any)?._wallet
    try {
      if (adopted) {
        const { sparkClientManager } = await import('../../lib/spark-client-manager')
        sparkClientManager.releaseExternalWallet(adopted)
      }
    } catch {
      /* the glue is optional on connect; releasing it must not block teardown */
    }
    await super.disconnect()
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    this.assertConnected()
    // Warm the balance cache so the dashboard's first read is coalesced.
    await getSparkBalanceCached(this.rawWallet).catch(() => {})
    return {
      protocol: 'SPARK',
      connected: this.connected,
      network: this.network,
      syncStatus: { synced: true, progress: 100 },
    }
  }

  // --- Address / receive --------------------------------------------------
  async getReceiveAddress(assetId?: string): Promise<Address> {
    this.assertConnected()
    // Spark-to-Spark native address.
    if (assetId === 'SPARK') {
      const address = await this.account.getAddress()
      return { address, format: 'SPARK_ADDRESS', asset: 'BTC' }
    }
    // BTC on-chain deposit address (default).
    if (!assetId || assetId.toLowerCase() === 'btc') {
      const address = await this.account.getSingleUseDepositAddress()
      return { address, format: 'BTC_ADDRESS', asset: 'BTC' }
    }
    throw new ProtocolError('Spark only supports BTC', 'SPARK', 'UNSUPPORTED_ASSET')
  }

  // --- Balance ------------------------------------------------------------
  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    this.assertConnected()
    const { balance } = await getSparkBalanceCached(this.rawWallet)
    const total = Number(balance)
    return { confirmed: total, unconfirmed: 0, total }
  }

  async refreshBalances(): Promise<void> {
    this.assertConnected()
    // Drop the short-TTL coalescing cache so the next read hits the gateway,
    // then reconcile server-side state (best-effort).
    invalidateSparkBalanceCache()
    await this.account.syncWalletBalance?.().catch(() => {})
  }

  async listAssets(): Promise<UnifiedAsset[]> {
    this.assertConnected()
    const { balance, tokenBalances } = await getSparkBalanceCached(this.rawWallet)
    const balanceSats = Number(balance)

    const btc: UnifiedAsset = {
      id: 'BTC',
      name: 'Bitcoin',
      ticker: 'BTC',
      precision: 8,
      protocol: 'SPARK',
      layer: 'SPARK_SPARK',
      balance: {
        total: balanceSats,
        available: balanceSats,
        pending: 0,
        locked: 0,
        totalDisplay: formatAmount(balanceSats, 8),
        availableDisplay: formatAmount(balanceSats, 8),
      },
      capabilities: {
        canSend: true,
        canReceive: true,
        canSwap: false,
        supportsLightning: true,
        supportsOnchain: true,
      },
    }
    const assets: UnifiedAsset[] = [btc]

    if (tokenBalances && tokenBalances.size > 0) {
      for (const [tokenId, info] of tokenBalances) {
        const meta: any = info.tokenMetadata
        const owned = Number(info.ownedBalance)
        const available = Number(info.availableToSendBalance)
        const precision = meta.decimals ?? 8
        assets.push({
          id: tokenId,
          name: meta.tokenName,
          ticker: meta.tokenTicker,
          icon: (meta as { tokenImageUrl?: string }).tokenImageUrl,
          precision,
          protocol: 'SPARK',
          layer: 'SPARK_SPARK',
          balance: {
            total: owned,
            available,
            pending: 0,
            locked: owned - available,
            totalDisplay: formatAmount(owned, precision),
            availableDisplay: formatAmount(available, precision),
          },
          capabilities: {
            canSend: true,
            canReceive: true,
            canSwap: false,
            supportsLightning: false,
            supportsOnchain: false,
          },
        })
      }
    }
    return assets
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets()
    const found = assets.find((a) => a.id === assetId || a.ticker === assetId)
    if (!found) throw new ProtocolError(`Asset not found: ${assetId}`, 'SPARK', 'ASSET_NOT_FOUND')
    return found
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    const found = await this.getAsset(assetId)
    return found.balance
  }

  // --- Invoices / receive amounts ----------------------------------------
  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    this.assertConnected()
    const expiresAt = Date.now() + (request.expirySeconds ?? 3600) * 1000

    // 1) Lightning receive (BOLT11) — when the caller targets the LN layer.
    if (request.layer === 'BTC_LN') {
      const r: any = await this.account.createLightningInvoice({
        amountSats: request.amount ?? 0,
        memo: request.description,
        expirySeconds: request.expirySeconds,
      })
      const inv: any = r?.invoice ?? {}
      const encoded = inv?.encodedInvoice ?? r?.encodedInvoice ?? r?.invoice ?? ''
      // Track the receive-request id so getInvoiceStatus can poll it later.
      if (r?.id && encoded) this.invoiceRequestIds.set(encoded, r.id)
      return {
        invoice: encoded,
        paymentHash: inv?.paymentHash ?? r?.id ?? '',
        amount: request.amount,
        expiresAt: parseSdkExpiryMs(inv?.expiryTime ?? inv?.expiresAt) ?? expiresAt,
        description: request.description,
      }
    }

    // 2) Spark token invoice — returns a SparkAddressFormat string.
    if (request.asset && request.asset !== 'BTC') {
      const invoice: string = await this.account.createSparkTokensInvoice({
        tokenIdentifier: request.asset,
        amount: request.assetAmount != null ? BigInt(request.assetAmount) : undefined,
        memo: request.description,
      })
      return { invoice, paymentHash: '', amount: request.assetAmount, expiresAt, description: request.description }
    }

    // 3) Default: native Spark sats invoice — returns a SparkAddressFormat string.
    const invoice: string = await this.account.createSparkSatsInvoice({
      amount: request.amount || undefined,
      memo: request.description,
    })
    return { invoice, paymentHash: '', amount: request.amount, expiresAt, description: request.description }
  }

  /** Optional: explicit native Spark sats invoice (used by the receive UI). */
  async createSparkInvoice(request: InvoiceRequest): Promise<Invoice> {
    this.assertConnected()
    const invoice: string = await this.account.createSparkSatsInvoice({
      amount: request.amount || undefined,
      memo: request.description,
      expiryTime: request.expirySeconds ? new Date(Date.now() + request.expirySeconds * 1000) : undefined,
    })
    return {
      invoice,
      paymentHash: '',
      amount: request.amount,
      expiresAt: Date.now() + (request.expirySeconds ?? 3600) * 1000,
      description: request.description,
    }
  }

  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    const dest = invoice.trim()
    if (isBolt11(dest)) {
      const { amountSat } = decodeBolt11(dest)
      return { paymentHash: '', amount: amountSat, expiresAt: 0, destination: dest }
    }
    // Spark invoice/address — no on-device decode; surface the raw value.
    return { paymentHash: '', expiresAt: 0, destination: dest }
  }

  // --- Send ---------------------------------------------------------------
  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    this.assertConnected()
    const destination = request.invoice.trim()
    const timestamp = Date.now()

    try {
      // 1) Lightning send (WDK account). payLightningInvoice only DISPATCHES;
      //    settlement is async on the SSP and can still fail, so poll the send
      //    request to a terminal state for the truth plus NIP-47's preimage.
      if (isBolt11(destination)) {
        const maxFee = (request as any).maxFeeSats ?? (request as any).maxFee ?? DEFAULT_MAX_FEE_SATS
        // Amountless (0-sat) invoices require an explicit amount; the SDK
        // rejects amountSatsToSend on amount-bearing ones, so gate on the
        // invoice itself, not on whether the caller supplied an amount.
        const invoiceIsAmountless = decodeBolt11(destination).amountMsat == null
        const result: any = await this.account.payLightningInvoice({
          invoice: destination,
          maxFeeSats: maxFee,
          ...(invoiceIsAmountless && request.amount && request.amount > 0
            ? { amountSatsToSend: request.amount }
            : {}),
        })
        const id = String(result?.id ?? result?.paymentHash ?? '')
        // Raw wallet access is best-effort: without it the poller degrades to
        // 'pending' rather than failing a payment that was already dispatched.
        const rawWallet = (this.account as any)?._wallet ?? {}
        const settlement = await waitForLightningSendSettlement(rawWallet, id, result ?? {})
        if (settlement.status === 'failed') {
          throw new ProtocolError(
            `Lightning payment failed (${settlement.rawStatus})`,
            'SPARK',
            'LIGHTNING_PAYMENT_FAILED',
          )
        }
        return {
          paymentHash: String(result?.paymentHash ?? result?.id ?? ''),
          preimage: settlement.preimage,
          amount: Number(result?.amountSats ?? result?.totalValue ?? request.amount ?? 0),
          fee: settlement.feeSats || Number(result?.feeSats ?? 0),
          status: settlement.status,
          timestamp: result?.createdTime instanceof Date ? result.createdTime.getTime() : timestamp,
        }
      }

      // 2) Spark address or Spark invoice (WDK account).
      if (this.sdk?.isValidSparkAddress?.(destination)) {
        const network = this.sdk.getNetworkFromSparkAddress(destination)
        const decoded = this.sdk.decodeSparkAddress(destination, network)

        if (decoded.sparkInvoiceFields) {
          const response: any = await this.account.paySparkInvoice([
            { invoice: destination, amount: request.amount ? BigInt(request.amount) : undefined },
          ])
          if (response.satsTransactionErrors?.length > 0) {
            throw new Error(response.satsTransactionErrors[0].error.message)
          }
          const success = response.satsTransactionSuccess?.[0]
          if (!success) throw new Error('Spark invoice payment returned no result')
          const transfer = success.transferResponse
          return {
            paymentHash: transfer.id,
            amount: Number(transfer.totalValue ?? 0),
            fee: 0,
            status: mapTransferStatus(transfer.status),
            timestamp: transfer.createdTime?.getTime() ?? timestamp,
          }
        }

        // Plain Spark address — zero-fee direct transfer.
        const transfer: any = await this.account.sendTransaction({ to: destination, value: request.amount ?? 0 })
        // A resolved SDK call is not proof the transfer exists. Without an id
        // there is nothing to reconcile or retry against, so fail loud rather
        // than hand the caller a success-shaped result with an empty
        // paymentHash — the Spark *invoice* branch above already does exactly
        // this ("returned no result"), and sendBtcOnchain does it too.
        const transferId = transfer?.id ?? transfer?.transferId ?? ''
        if (!transferId) {
          throw new ProtocolError(
            'Spark transfer returned no transaction id',
            'SPARK',
            'NO_TX_ID',
          )
        }
        return {
          paymentHash: transferId,
          amount: Number(transfer?.totalValue ?? request.amount ?? 0),
          fee: 0, // Spark transfers are zero-fee (capability flag)
          // An absent status means the SDK told us nothing about settlement —
          // that is 'pending', not 'confirmed'. Defaulting to confirmed reported
          // funds as moved on no evidence.
          status: transfer?.status ? mapTransferStatus(transfer.status) : 'pending',
          timestamp: transfer?.createdTime?.getTime?.() ?? timestamp,
        }
      }

      // 3) On-chain BTC withdrawal (cooperative exit) via the raw wallet — the
      //    WDK withdraw option shape differs; use the proven native path.
      const wallet = this.rawWallet
      const feeQuote: any = await wallet.getWithdrawalFeeQuote({
        amountSats: request.amount ?? 0,
        withdrawalAddress: destination,
      })
      if (!feeQuote) throw new Error('Failed to get withdrawal fee quote for on-chain exit')
      const feeAmountSats =
        (feeQuote.l1BroadcastFeeMedium?.originalValue ?? 0) + (feeQuote.userFeeMedium?.originalValue ?? 0)
      const result: any = await wallet.withdraw({
        onchainAddress: destination,
        amountSats: request.amount ?? 0,
        exitSpeed: this.sdk?.ExitSpeed?.MEDIUM ?? 'MEDIUM',
        feeQuoteId: feeQuote.id,
        feeAmountSats,
      })
      return {
        paymentHash: result?.id ?? '',
        amount: request.amount ?? 0,
        fee: result?.fee?.originalValue ?? 0,
        status: 'pending',
        timestamp,
      }
    } finally {
      // Any send attempt (success OR failure) makes the cached balance stale.
      invalidateSparkBalanceCache()
    }
  }

  async getPaymentStatus(paymentId: string): Promise<PaymentStatus> {
    this.assertConnected()
    // Spark may return entity ids like "SparkLightningSendRequest:uuid"; getTransactionReceipt wants the uuid.
    const id = paymentId.includes(':') ? paymentId.split(':').pop()! : paymentId
    let t: any
    try {
      t = await this.account.getTransactionReceipt(id)
    } catch {
      return { paymentHash: paymentId, status: 'unknown' }
    }
    if (!t) return { paymentHash: paymentId, status: 'pending' }
    return {
      paymentHash: paymentId,
      status: mapSparkStatus(t.status),
      amount: Number(t.totalValue ?? 0),
      timestamp: t.createdTime?.getTime?.() ?? 0,
    }
  }

  // --- Transactions -------------------------------------------------------
  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    this.assertConnected()
    const limit = filter?.limit ?? 20
    const offset = filter?.offset ?? 0
    const requestedAsset = filter?.asset?.trim()
    const shouldFetchBtc = !requestedAsset || requestedAsset === 'BTC'
    const shouldFetchTokens = !requestedAsset || requestedAsset !== 'BTC'

    // BTC transfers via the WDK account — best effort; a failure here must not
    // hide token activity (and especially not the offline send-record fallback).
    let btcTxs: UnifiedTransaction[] = []
    if (shouldFetchBtc) {
      try {
        const transfers: any[] = await this.account.getTransfers({ limit, skip: offset })
        btcTxs = (transfers ?? []).map((t) => this.toUnifiedTx(t))
      } catch {
        /* isolated */
      }
    }

    // Token transactions via the raw wallet — every RPC below is best-effort and
    // isolated so a transport failure never hides locally-recorded sends (the only
    // reliable record of an outgoing token transfer with no change output).
    const tokenTxs: UnifiedTransaction[] = []
    if (shouldFetchTokens) {
      try {
        const wallet = this.rawWallet
        const requestedTokenRawId =
          requestedAsset && requestedAsset !== 'BTC' ? rawTokenIdFromBech32mTokenId(requestedAsset) : ''
        // spark-converters statically imports the SDK — dynamic-import so this
        // sub-path stays SDK-free until token history is actually requested.
        const { convertTokenTransactionToUnified, buildSentRecordTransaction } = await import(
          '../../lib/spark-converters'
        )

        const sparkAddress: string = await wallet.getSparkAddress()
        const identityPubKey = await wallet.getIdentityPublicKey()
        let networkType = ''
        try {
          networkType = this.sdk.getNetworkFromSparkAddress(sparkAddress)
        } catch {
          /* non-fatal */
        }

        const tokenMetaMap = new Map<string, { name: string; ticker: string; decimals: number }>()
        const rawTokenMetaMap = new Map<
          string,
          { id: string; meta: { name: string; ticker: string; decimals: number } }
        >()
        try {
          const { tokenBalances } = await wallet.getBalance()
          if (tokenBalances) {
            for (const [tokenId, info] of tokenBalances) {
              const meta = {
                name: info.tokenMetadata.tokenName,
                ticker: info.tokenMetadata.tokenTicker,
                decimals: info.tokenMetadata.decimals,
              }
              tokenMetaMap.set(tokenId, meta)
              const rawTokenId = rawTokenIdFromBytes(
                (info.tokenMetadata as { rawTokenIdentifier?: Uint8Array }).rawTokenIdentifier,
              )
              if (rawTokenId) rawTokenMetaMap.set(rawTokenId, { id: tokenId, meta })
            }
          }
        } catch {
          /* isolated */
        }

        const allSentRecords = await loadSentTokenRecords()
        const walletSentRecords = allSentRecords.filter((r) => r.senderSparkAddress === sparkAddress)
        const sentRecords =
          requestedAsset && requestedAsset !== 'BTC'
            ? walletSentRecords.filter((r) => tokenRefsMatch(r.assetId, requestedAsset))
            : walletSentRecords
        const sentHashSet = new Set(sentRecords.map((r) => normalizeTxHash(r.hash)))
        const storedRecordMap = new Map<string, SentTokenTxRecord>(
          sentRecords.map((r) => [normalizeTxHash(r.hash), r]),
        )
        const storedAmountMap = new Map<string, bigint>(
          sentRecords.map((r) => [normalizeTxHash(r.hash), BigInt(Math.round(r.amount || 0))]),
        )

        const txsWithStatus: Array<{ tokenTransaction?: unknown; status: number; tokenTransactionHash: Uint8Array }> = []
        try {
          const result = await wallet.queryTokenTransactions({
            ownerPublicKeys: [identityPubKey],
            tokenIdentifiers: requestedAsset && requestedAsset !== 'BTC' ? [requestedAsset] : undefined,
            pageSize: limit,
          })
          txsWithStatus.push(...(result.tokenTransactionsWithStatus ?? []))
        } catch {
          /* isolated */
        }

        // Sends with no change output are invisible to the owner-filtered query — fetch by hash.
        if (sentRecords.length > 0) {
          try {
            const sentResult = await wallet.queryTokenTransactionsByTxHashes(
              sentRecords.map((r) => normalizeTxHash(r.hash)),
            )
            const existing = new Set(txsWithStatus.map((t) => txHashFromBytes(t.tokenTransactionHash)))
            for (const sentTx of sentResult.tokenTransactionsWithStatus ?? []) {
              if (!existing.has(txHashFromBytes(sentTx.tokenTransactionHash))) txsWithStatus.push(sentTx)
            }
          } catch {
            /* isolated */
          }
        }

        const renderedSendHashes = new Set<string>()
        for (const txWithStatus of txsWithStatus) {
          const converted = convertTokenTransactionToUnified(
            txWithStatus,
            identityPubKey,
            tokenMetaMap,
            rawTokenMetaMap,
            sentHashSet,
            storedRecordMap,
            storedAmountMap,
            networkType,
            requestedAsset && requestedAsset !== 'BTC' ? requestedAsset : undefined,
            requestedTokenRawId,
          )
          if (converted) {
            tokenTxs.push(converted)
            const hash = txHashFromBytes(txWithStatus.tokenTransactionHash)
            if (sentHashSet.has(hash)) renderedSendHashes.add(hash)
          }
        }

        // Offline / failed-fetch fallback: synthesize from any recorded send the gateway did not return.
        for (const record of sentRecords) {
          const hash = normalizeTxHash(record.hash)
          if (renderedSendHashes.has(hash)) continue
          tokenTxs.push(
            buildSentRecordTransaction(record, requestedAsset && requestedAsset !== 'BTC' ? requestedAsset : undefined),
          )
        }
      } catch {
        /* isolated — token history is additive to BTC history */
      }
    }

    const allTxs = [...btcTxs, ...tokenTxs].sort((a, b) => b.timestamp - a.timestamp)
    const matched = allTxs.filter((tx) => {
      if (!filter) return true
      if (
        filter.asset &&
        tx.asset?.id !== filter.asset &&
        tx.asset?.ticker !== filter.asset &&
        !tokenRefsMatch(tx.asset?.id, filter.asset)
      )
        return false
      if (filter.type && tx.type !== filter.type) return false
      if (filter.status && tx.status !== filter.status) return false
      if (filter.fromTimestamp && tx.timestamp < filter.fromTimestamp) return false
      if (filter.toTimestamp && tx.timestamp > filter.toTimestamp) return false
      return true
    })

    // Honour `limit` on the MERGED result. `limit` is pushed into each leg's
    // RPC, but two legs each returning up to `limit` rows merge to up to twice
    // that — and the recorded-send / synthesized-offline-record paths are not
    // paged at all. Measured before this cap: `listTransactions({ limit: 5 })`
    // returned 16 rows. Capping here is what makes the documented page size
    // true (audit finding G-F8, Spark half).
    //
    // ORDER IS NOT TOUCHED: the newest-first sort above already ran, and this
    // takes a prefix of it.
    //
    // `offset` is deliberately NOT re-applied here. It is already pushed into
    // the BTC leg's RPC, so slicing the merged array by it a second time would
    // drop rows the caller never saw. Sound merge-level pagination would have
    // to over-fetch `offset + limit` from every leg and page the union — a
    // different paging model, and a larger change than making the count
    // honest. Carried as an open item.
    return matched.slice(0, Math.max(0, limit))
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    this.assertConnected()
    const t: any = await this.account.getTransactionReceipt(txId)
    if (!t) throw new ProtocolError(`Transaction not found: ${txId}`, 'SPARK', 'TX_NOT_FOUND')
    return this.toUnifiedTx(t)
  }

  /** Map a spark-sdk Transfer (proto) → domain UnifiedTransaction (fields read defensively). */
  private toUnifiedTx(t: any): UnifiedTransaction {
    // The spark-sdk Transfer proto has no direction flag — direction is whether
    // *we* are the receiver, so compare our cached identity pubkey against the
    // transfer's receiver/sender keys. The legacy direction fields are a fallback
    // only when the identity key is unknown.
    const me = this.identityPubKeyHex
    const receiverHex = toHexLower(t?.receiverIdentityPublicKey)
    const senderHex = toHexLower(t?.senderIdentityPublicKey)
    let isReceive: boolean
    if (me && (receiverHex || senderHex)) {
      isReceive = receiverHex === me && senderHex !== me
    } else {
      const dir = String(t?.transferDirection ?? t?.direction ?? '').toUpperCase()
      isReceive = dir.includes('INCOMING') || dir.includes('RECEIV')
    }
    const tsRaw = t?.createdTime ?? t?.updatedTime ?? t?.createdAt
    const timestamp =
      typeof tsRaw === 'number'
        ? tsRaw
        : tsRaw?.seconds
          ? Number(tsRaw.seconds) * 1000
          : tsRaw
            ? new Date(tsRaw).getTime()
            : 0
    return {
      id: t?.id ?? t?.sparkId ?? '',
      type: isReceive ? 'receive' : 'send',
      status: isDirectSparkTransfer(t) ? 'confirmed' : mapSparkStatus(t?.status),
      timestamp,
      amount: Number(t?.totalValue ?? t?.value ?? 0),
      amountDisplay: '',
      asset: undefined as unknown as UnifiedAsset,
      protocolData: t,
    }
  }

  // --- Node & balance -----------------------------------------------------
  async getNodeInfo(): Promise<NodeInfo> {
    this.assertConnected()
    const { balance } = await getSparkBalanceCached(this.rawWallet)
    const balanceSats = Number(balance)
    return {
      channelsBalanceMsat: balanceSats * 1000,
      maxPayableMsat: balanceSats * 1000,
      onchainBalanceMsat: 0,
      pendingOnchainBalanceMsat: 0,
      maxReceivableMsat: 0,
      inboundLiquidityMsats: 0,
      connectedPeers: [],
      utxos: 0,
    }
  }

  async listChannels(): Promise<any[]> {
    // A disconnected adapter must not answer as if this were the wallet's state:
    // a dashboard that skipped its own isConnected() gate renders "0 channels /
    // 0 transfers" for a locked wallet. `listChannels`' JSDoc conditions the empty
    // array on the PROTOCOL having no channels, not on being disconnected, and
    // every sibling read on these adapters already asserts (audit finding G-F9).
    this.assertConnected()
    return [] // Spark has no LN channels
  }

  async listPayments(): Promise<any> {
    // Outgoing transfers only.
    const txs = await this.listTransactions()
    return { transfers: txs.filter((t) => t.type === 'send') }
  }

  async listTransfers(): Promise<any> {
    this.assertConnected()
    // Spark has no RGB-style per-asset transfers.
    return { transfers: [] }
  }

  /**
   * Escape hatch: the underlying spark-sdk SparkWallet, for integrations needing the
   * raw client (e.g. the flashnet Spark-DEX). Null if not connected.
   */
  getUnderlyingSparkWallet(): any {
    return (this.account as any)?._wallet ?? null
  }

  // --- Deposits (L1) ------------------------------------------------------
  async claimSparkL1Deposit(params: {
    address: string
  }): Promise<{ status: 'awaiting' | 'claimed' | 'error'; txids?: string[]; error?: string }> {
    this.assertConnected()
    const address = params.address?.trim()
    if (!address) return { status: 'error', error: 'address is required' }
    const wallet = this.rawWallet

    let utxos: Array<{ txid: string; vout: number }>
    try {
      utxos = await wallet.getUtxosForDepositAddress(address, 10, 0, true)
    } catch (error: unknown) {
      return { status: 'error', error: error instanceof Error ? error.message : 'utxo lookup failed' }
    }
    if (!utxos || utxos.length === 0) return { status: 'awaiting' }

    const claimedTxids: string[] = []
    let lastError: string | undefined
    for (const utxo of utxos) {
      try {
        await wallet.claimDeposit(utxo.txid)
        claimedTxids.push(utxo.txid)
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    if (claimedTxids.length === 0) return { status: 'error', error: lastError ?? 'no utxos claimed' }
    invalidateSparkBalanceCache()
    return { status: 'claimed', txids: claimedTxids }
  }

  async sweepSparkL1Deposits(): Promise<{ addressesChecked: number; claimedTxids: string[]; errors: string[] }> {
    this.assertConnected()
    const wallet = this.rawWallet

    let unused: string[]
    try {
      unused = await wallet.getUnusedDepositAddresses()
    } catch (error: unknown) {
      return {
        addressesChecked: 0,
        claimedTxids: [],
        errors: [error instanceof Error ? error.message : 'getUnusedDepositAddresses failed'],
      }
    }
    if (!unused || unused.length === 0) return { addressesChecked: 0, claimedTxids: [], errors: [] }

    const claimedTxids: string[] = []
    const errors: string[] = []
    for (const addr of unused) {
      try {
        const utxos = await wallet.getUtxosForDepositAddress(addr, 10, 0, true)
        if (!utxos || utxos.length === 0) continue
        for (const utxo of utxos) {
          try {
            await wallet.claimDeposit(utxo.txid)
            claimedTxids.push(utxo.txid)
          } catch (claimErr: unknown) {
            errors.push(claimErr instanceof Error ? claimErr.message : String(claimErr))
          }
        }
      } catch (lookupErr: unknown) {
        errors.push(lookupErr instanceof Error ? lookupErr.message : String(lookupErr))
      }
    }
    if (claimedTxids.length > 0) invalidateSparkBalanceCache()
    return { addressesChecked: unused.length, claimedTxids, errors }
  }

  // --- On-chain / asset send ---------------------------------------------
  async sendBtcOnchain(params: { address: string; amount: number; feeRate?: number }): Promise<Record<string, unknown>> {
    this.assertConnected()
    const wallet = this.rawWallet
    try {
      const feeQuote: any = await wallet.getWithdrawalFeeQuote({
        amountSats: params.amount,
        withdrawalAddress: params.address,
      })
      if (!feeQuote) throw new Error('Failed to get withdrawal fee quote')
      const feeAmountSats =
        (feeQuote.l1BroadcastFeeMedium?.originalValue ?? 0) + (feeQuote.userFeeMedium?.originalValue ?? 0)
      const result: any = await wallet.withdraw({
        onchainAddress: params.address,
        amountSats: params.amount,
        exitSpeed: this.sdk?.ExitSpeed?.MEDIUM ?? 'MEDIUM',
        feeQuoteId: feeQuote.id,
        feeAmountSats,
      })
      return result as Record<string, unknown>
    } finally {
      invalidateSparkBalanceCache()
    }
  }

  async sendAsset(params: {
    assetId: string
    amount: number
    recipientId: string
    assignment?: { type: string; value: number } | null
  }): Promise<Record<string, unknown>> {
    this.assertConnected()
    const wallet = this.rawWallet
    const assignmentAmount = params.assignment?.value
    const tokenAmount =
      typeof assignmentAmount === 'number' && assignmentAmount > 0 ? assignmentAmount : params.amount
    if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
      throw new ProtocolError('Spark token amount must be greater than 0', 'SPARK', 'SEND_ASSET_ERROR')
    }
    const destination = params.recipientId.trim()
    const senderSparkAddress: string = await wallet.getSparkAddress()

    // Resolve token metadata for the send-record (cached balance is warm from the send UI).
    let sentMeta = { ticker: 'TOKEN', name: params.assetId, decimals: 0 }
    try {
      const { tokenBalances } = await getSparkBalanceCached(wallet)
      const info: any = tokenBalances?.get(params.assetId as any)
      if (info) {
        sentMeta = {
          ticker: info.tokenMetadata.tokenTicker,
          name: info.tokenMetadata.tokenName,
          decimals: info.tokenMetadata.decimals,
        }
      }
    } catch {
      /* non-critical */
    }

    try {
      // Spark token invoice → fulfillSparkInvoice.
      if (this.sdk?.isValidSparkAddress?.(destination)) {
        const network = this.sdk.getNetworkFromSparkAddress(destination)
        const decoded = this.sdk.decodeSparkAddress(destination, network)
        if (decoded.sparkInvoiceFields) {
          const response: any = await wallet.fulfillSparkInvoice([
            { invoice: destination, amount: BigInt(tokenAmount) },
          ])
          if (response.tokenTransactionErrors?.length > 0) throw new Error(response.tokenTransactionErrors[0].error.message)
          if (response.invalidInvoices?.length > 0) throw new Error(response.invalidInvoices[0].error.message)
          const success = response.tokenTransactionSuccess?.[0]
          if (success) {
            await saveSentTokenRecord({
              hash: success.txid,
              senderSparkAddress,
              amount: tokenAmount,
              assetId: params.assetId,
              ...sentMeta,
              timestamp: Date.now(),
            })
            invalidateSparkBalanceCache()
            return { txId: success.txid }
          }
          // No sats-leg fallback — see the note on `SparkAdapter.sendAsset`
          // (audit finding G-F5). An empty `tokenTransactionSuccess` means the token
          // leg did not succeed; returning a SATS transfer id as the result of a
          // TOKEN send reports a success that did not happen, with the id of a
          // different transfer, and skips `saveSentTokenRecord`. A genuinely bundled
          // sats+token invoice succeeds on both legs, so `success` above covers it.
          throw new ProtocolError(
            'Spark invoice payment returned no token transfer result',
            'SPARK',
            'SEND_ASSET_ERROR',
          )
        }
      }

      // Plain Spark address → transferTokens.
      const txId: string = await wallet.transferTokens({
        tokenIdentifier: params.assetId as any,
        tokenAmount: BigInt(tokenAmount),
        receiverSparkAddress: destination,
      })
      await saveSentTokenRecord({
        hash: txId,
        senderSparkAddress,
        amount: tokenAmount,
        assetId: params.assetId,
        ...sentMeta,
        timestamp: Date.now(),
      })
      invalidateSparkBalanceCache()
      return { txId }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new ProtocolError(`Failed to send Spark token: ${msg}`, 'SPARK', 'SEND_ASSET_ERROR', error)
    }
  }

  // --- Invoice status -----------------------------------------------------
  async getInvoiceStatus(params: { invoice: string }): Promise<{ status: string }> {
    this.assertConnected()
    const requestId = this.invoiceRequestIds.get(params.invoice)
    if (!requestId) return { status: 'Pending' } // untracked (e.g. previous session)
    try {
      const request: any = await this.rawWallet.getLightningReceiveRequest(requestId)
      if (!request) return { status: 'Pending' }
      const s = request.status
      if (s === 'LIGHTNING_PAYMENT_RECEIVED' || s === 'TRANSFER_COMPLETED' || s === 'PAYMENT_PREIMAGE_RECOVERED') {
        this.invoiceRequestIds.delete(params.invoice)
        return { status: 'Succeeded' }
      }
      if (
        s === 'TRANSFER_FAILED' ||
        s === 'TRANSFER_CREATION_FAILED' ||
        s === 'REFUND_SIGNING_COMMITMENTS_QUERYING_FAILED' ||
        s === 'REFUND_SIGNING_FAILED' ||
        s === 'PAYMENT_PREIMAGE_RECOVERING_FAILED'
      ) {
        this.invoiceRequestIds.delete(params.invoice)
        return { status: 'Failed' }
      }
      return { status: 'Pending' }
    } catch {
      return { status: 'Pending' }
    }
  }

  // --- RGB (not supported by Spark) --------------------------------------
  async createRgbInvoice(): Promise<never> {
    throw new ProtocolError('RGB invoices not supported by Spark', 'SPARK', 'NOT_SUPPORTED')
  }

  async decodeRgbInvoice(): Promise<never> {
    throw new ProtocolError('RGB invoice decoding not supported by Spark', 'SPARK', 'NOT_SUPPORTED')
  }

  // --- Message / PSBT signing --------------------------------------------
  async signPsbt(psbtHex: string): Promise<{ psbt: string; unchanged: boolean }> {
    this.assertConnected()
    if (!this.mnemonic) throw new ProtocolError('Wallet mnemonic not available', 'SPARK', 'NOT_CONNECTED')
    const { signPsbt: doSign } = await import('../../lib/psbt-signer')
    const result = doSign(psbtHex, this.mnemonic)
    return { psbt: result.psbt, unchanged: result.unchanged }
  }

  async signMessage(message: string): Promise<string> {
    this.assertConnected()
    if (!this.mnemonic) throw new ProtocolError('Wallet mnemonic not available', 'SPARK', 'NOT_CONNECTED')
    const { HDKey } = await import('@scure/bip32')
    const seed = resolveWalletSeed(this.mnemonic)
    const root = HDKey.fromMasterSeed(seed)
    // m/138'/1 — wallet-identity message-signing key (distinct from LNURL-auth's m/138'/0).
    const node = root.derive("m/138'/1")
    if (!node.privateKey) {
      throw new ProtocolError('Failed to derive message-signing key', 'SPARK', 'KEY_DERIVATION_ERROR')
    }
    return signLnMessage(message, node.privateKey)
  }

  async verifyMessage(message: string, signature: string): Promise<string> {
    return verifyLnMessage(message, signature)
  }
}
