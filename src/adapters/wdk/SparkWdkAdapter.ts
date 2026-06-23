/**
 * SparkWdkAdapter
 * ---------------
 * Thin adapter mapping the WDK Spark module (@tetherto/wdk-wallet-spark) onto the
 * stable `IProtocolAdapter` contract. This is the reference implementation of the
 * "wrap a WDK module behind the contract" pattern (see docs/WDK_INTEGRATION_PLAN.md).
 *
 * Discipline rules enforced here:
 *  - NO WDK/SDK types cross the contract boundary — everything returned is a domain
 *    type from ../types/base. The WDK objects are held as `any` internally.
 *  - Protocol quirks (zero-fee, static address) live in the capability manifest,
 *    not in this interface.
 *
 * WDK Spark account surface (captured via Spike A, 2026-06-03):
 *   manager: getAccount, getAccountByPath, getFeeRates
 *   account: getAddress, getBalance, sendTransaction, transfer,
 *            getStaticDepositAddress, getSingleUseDepositAddress, quoteWithdraw,
 *            withdraw, createLightningInvoice, payLightningInvoice,
 *            createSparkSatsInvoice, createSparkTokensInvoice, paySparkInvoice,
 *            syncWalletBalance, dispose, cleanupConnections
 *
 * Status: skeleton — core receive/balance/invoice/send wired to the real WDK calls;
 * remaining contract methods stubbed with explicit ProtocolError until Phase 2.
 */

import { IProtocolAdapter, BaseProtocolConfig } from '../IProtocolAdapter'
import {
  ProtocolType,
  Layer,
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
import { BaseWdkAdapter } from './BaseWdkAdapter'

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
  const hasTransferShape = t?.receiverIdentityPublicKey != null || t?.senderIdentityPublicKey != null || t?.totalValue != null
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

  // --- Connection ---------------------------------------------------------
  async connect(config: BaseProtocolConfig): Promise<void> {
    const cfg = config as SparkAdapterConfig
    if (!cfg.mnemonic) {
      throw new ProtocolError('SparkWdkAdapter requires a mnemonic', 'SPARK', 'CONFIG')
    }
    this.network = cfg.network ?? 'mainnet'
    // Injectable loader (RN injects a static require; Node/Vite use the import fallback).
    // @ts-ignore — declared as a workspace/optional dep; resolved at runtime.
    const mod = await loadWdkModule('@tetherto/wdk-wallet-spark', () => import('@tetherto/wdk-wallet-spark'))
    const WalletManagerSpark = mod.default ?? mod
    this.manager = new WalletManagerSpark(cfg.mnemonic, {
      network: SPARK_NETWORK_MAP[this.network] ?? 'MAINNET',
    })
    this.account = await this.manager.getAccount(cfg.accountIndex ?? 0)
    try {
      this.identityPubKeyHex = toHexLower(await this.account.getIdentityKey?.()) || null
    } catch {
      this.identityPubKeyHex = null
    }
    this.connected = true
  }


  async getConnectionInfo(): Promise<ConnectionInfo> {
    return { protocol: 'SPARK', connected: this.connected, network: this.network }
  }

  // --- Address / receive --------------------------------------------------
  async getReceiveAddress(): Promise<Address> {
    this.assertConnected()
    const address = await this.account.getAddress()
    return { address, format: 'SPARK_ADDRESS' }
  }

  // --- Balance ------------------------------------------------------------
  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    this.assertConnected()
    // WDK: getBalance(): Promise<bigint> — sats, settled balance.
    const bal: bigint = await this.account.getBalance()
    const total = Number(bal)
    return { confirmed: total, unconfirmed: 0, total }
  }

  async refreshBalances(): Promise<void> {
    this.assertConnected()
    await this.account.syncWalletBalance?.()
  }

  async listAssets(): Promise<UnifiedAsset[]> {
    this.assertConnected()
    const { total } = await this.getBtcBalance()
    const btc: UnifiedAsset = {
      id: 'BTC',
      name: 'Bitcoin',
      ticker: 'BTC',
      precision: 8,
      protocol: 'SPARK',
      layer: 'BTC_SPARK',
      balance: {
        total,
        available: total,
        pending: 0,
        totalDisplay: String(total),
        availableDisplay: String(total),
      },
      capabilities: {
        canSend: true,
        canReceive: true,
        canSwap: false,
        supportsLightning: true,
        supportsOnchain: true,
      },
    }
    const out: UnifiedAsset[] = [btc]

    // Spark tokens. The WDK account wraps a SparkWallet whose `getBalance()`
    // returns `{ satsBalance, tokenBalances }`, where tokenBalances is a
    // Map<bech32m identifier, { balance, tokenMetadata|tokenInfo }>. Token
    // enumeration is best-effort: never let it break the BTC listing.
    try {
      const wallet: any = (this.account as any)?._wallet
      const full: any = wallet?.getBalance ? await wallet.getBalance() : null
      const tokenBalances: any = full?.tokenBalances
      if (tokenBalances && typeof tokenBalances.forEach === 'function') {
        // TokenBalanceMap value = { ownedBalance, availableToSendBalance, tokenMetadata }
        // (UserTokenMetadata: tokenName/tokenTicker/decimals). There is NO `balance`
        // field — reading it returned 0. The Map key is the bech32m token identifier.
        tokenBalances.forEach((entry: any, key: string) => {
          const meta: any = entry?.tokenMetadata ?? entry?.tokenInfo ?? {}
          const id: string = String(key)
          if (!id) return
          const owned = Number(entry?.ownedBalance ?? entry?.balance ?? 0)
          const available = Number(entry?.availableToSendBalance ?? entry?.ownedBalance ?? 0)
          const decimals = Number(meta.decimals ?? meta.tokenDecimals ?? 0)
          const ticker = meta.tokenTicker ?? meta.tokenSymbol ?? meta.symbol ?? id.slice(0, 6)
          out.push({
            id,
            name: meta.tokenName ?? meta.name ?? ticker,
            ticker,
            precision: decimals,
            protocol: 'SPARK',
            layer: 'SPARK_SPARK',
            balance: {
              total: owned,
              available,
              pending: 0,
              totalDisplay: String(owned),
              availableDisplay: String(available),
            },
            capabilities: {
              canSend: true,
              canReceive: true,
              canSwap: true,
              supportsLightning: false,
              supportsOnchain: false,
            },
          })
        })
      }
    } catch {
      // tokens are best-effort — keep BTC even if the token map is unavailable
    }
    return out
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    const assets = await this.listAssets()
    const found = assets.find((a) => a.id === assetId)
    if (!found) throw new ProtocolError(`Unknown asset ${assetId}`, 'SPARK', 'NO_ASSET')
    return found.balance
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const assets = await this.listAssets()
    const found = assets.find((a) => a.id === assetId)
    if (!found) throw new ProtocolError(`Unknown asset ${assetId}`, 'SPARK', 'NO_ASSET')
    return found
  }

  // --- Invoices / receive amounts ----------------------------------------
  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    this.assertConnected()
    const expiresAt = Date.now() + (request.expirySeconds ?? 3600) * 1000

    // 1) Lightning receive (BOLT11) — when the caller targets the LN layer.
    if (request.layer === 'BTC_LN') {
      // WDK createLightningInvoice({ amountSats, memo, expirySeconds }): LightningReceiveRequest
      const r: any = await this.account.createLightningInvoice({
        amountSats: request.amount ?? 0,
        memo: request.description,
        expirySeconds: request.expirySeconds,
      })
      const encoded = r?.invoice?.encodedInvoice ?? r?.encodedInvoice ?? r?.invoice ?? ''
      return {
        invoice: encoded,
        paymentHash: r?.invoice?.paymentHash ?? r?.id ?? '',
        amount: request.amount,
        expiresAt,
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
      amount: request.amount,
      memo: request.description,
    })
    return { invoice, paymentHash: '', amount: request.amount, expiresAt, description: request.description }
  }

  // --- Send ---------------------------------------------------------------
  async sendPayment(request: PaymentRequest): Promise<PaymentResult> {
    this.assertConnected()
    const dest = request.invoice.trim()
    const isBolt11 = /^ln(bc|tb|bcrt)/i.test(dest)
    const timestamp = Date.now()

    // 1) Lightning send — WDK requires a maxFeeSats cap.
    if (isBolt11) {
      const r: any = await this.account.payLightningInvoice({
        invoice: dest,
        maxFeeSats: request.maxFeeSats ?? this.defaultMaxFeeSats(request.amount),
        // Required by the underlying Spark SDK for 0-amount (amountless) invoices;
        // for invoices that already carry an amount this must be omitted. The WDK
        // module forwards these options verbatim to spark-sdk's payLightningInvoice.
        ...(request.amount && request.amount > 0 ? { amountSatsToSend: request.amount } : {}),
      })
      return {
        paymentHash: r?.paymentHash ?? r?.id ?? '',
        preimage: r?.preimage,
        amount: Number(r?.amountSats ?? request.amount ?? 0),
        fee: Number(r?.feeSats ?? 0),
        status: 'confirmed',
        timestamp,
      }
    }

    // 2) Plain Spark address + explicit amount → direct transfer (zero-fee).
    if (request.amount != null) {
      const r: any = await this.account.sendTransaction({ to: dest, value: request.amount })
      return {
        paymentHash: r?.id ?? r?.transferId ?? '',
        amount: request.amount,
        fee: 0, // Spark transfers are zero-fee (capability flag)
        status: 'confirmed',
        timestamp,
      }
    }

    // 3) Encoded Spark invoice (amount embedded) → fulfill. Takes an ARRAY.
    const res: any = await this.account.paySparkInvoice([{ invoice: dest }])
    const ok = res?.satsTransactionSuccess?.[0]
    return {
      paymentHash: ok?.transferResponse?.id ?? '',
      amount: Number(request.amount ?? 0),
      fee: 0,
      status: ok ? 'confirmed' : 'failed',
      timestamp,
    }
  }

  /** Conservative default LN fee cap: 0.5% of amount, min 5 sats. */
  private defaultMaxFeeSats(amount?: number): number {
    if (!amount || amount <= 0) return 10
    return Math.max(5, Math.ceil(amount * 0.005))
  }

  // --- Transactions -------------------------------------------------------
  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    const dest = invoice.trim()
    if (isBolt11(dest)) {
      const { amountSat } = decodeBolt11(dest)
      return { paymentHash: '', amount: amountSat, expiresAt: 0, destination: dest }
    }
    // Spark invoice/address — no on-device decode; surface the raw value.
    return { paymentHash: '', expiresAt: 0, destination: dest }
  }

  async getPaymentStatus(paymentHash: string): Promise<PaymentStatus> {
    this.assertConnected()
    const t: any = await this.account.getTransactionReceipt(paymentHash).catch(() => null)
    return { paymentHash, status: mapSparkStatus(t?.status), amount: t ? Number(t.totalValue ?? 0) : undefined }
  }

  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    this.assertConnected()
    const transfers: any[] = await this.account.getTransfers({ limit: filter?.limit ?? 50, skip: filter?.offset ?? 0 })
    return (transfers ?? []).map((t) => this.toUnifiedTx(t))
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    this.assertConnected()
    const t: any = await this.account.getTransactionReceipt(txId)
    if (!t) throw new ProtocolError(`Unknown tx ${txId}`, 'SPARK', 'NO_TX')
    return this.toUnifiedTx(t)
  }

  async getNodeInfo(): Promise<any> {
    return { protocol: 'SPARK', network: this.network }
  }
  async listChannels(): Promise<any[]> {
    return [] // Spark has no LN channels
  }

  /**
   * Escape hatch: the underlying spark-sdk SparkWallet, for integrations that need the
   * raw client (e.g. the flashnet Spark-DEX, which piggybacks on a SparkWallet). Returns
   * the same instance this adapter uses (no duplicate wallet). Null if not connected.
   */
  getUnderlyingSparkWallet(): any {
    return (this.account as any)?._wallet ?? null
  }
  async listPayments(): Promise<any> {
    // Outgoing transfers only.
    const txs = await this.listTransactions()
    return txs.filter((t) => t.type === 'send')
  }
  async listTransfers(): Promise<any> {
    this.assertConnected()
    return this.account.getTransfers({ limit: 100 })
  }

  /** Map a spark-sdk Transfer (proto) → domain UnifiedTransaction (fields read defensively). */
  private toUnifiedTx(t: any): UnifiedTransaction {
    // The spark-sdk Transfer proto has no direction flag — direction is whether
    // *we* are the receiver. Compare our cached identity pubkey against the
    // transfer's receiver/sender identity keys. Fall back to the (legacy, usually
    // absent) direction fields only when the identity key is unknown.
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
}
