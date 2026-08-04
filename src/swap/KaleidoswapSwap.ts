/**
 * KaleidoswapSwap
 * ---------------
 * Wraps the WDK Kaleidoswap swap protocol module (@kaleidorg/wdk-protocol-swap-kaleidoswap)
 * behind domain `Quote`/`SwapResult` types. This is the cross-asset swap path (RFQ via the
 * maker, settled as an atomic HTLC swap over Lightning) — distinct from the lower-level
 * cross-L2 atomic (VHTLC/Boltz) layer in types/cross-l2.
 *
 * The swap module is bound to an account (the taker's RLN account, which whitelists the
 * HTLC) + a baseUrl. No WDK/kaleido-sdk types cross this boundary.
 *
 * UNITS: every amount on this boundary is in RAW base units (satoshis for BTC, the
 * asset's smallest unit for RGB assets) — the module rejects fractional inputs, so a
 * display-unit caller fails loudly instead of creating an order scaled by 10^precision.
 * Execution passes the approved quote's rfqId and exact raw amounts to the maker, so a
 * fill can never diverge from what the user approved on either leg.
 */

import { Quote, QuoteRequest, SwapResult, ProtocolError } from '../types/base'
import { loadWdkModule } from '../adapters/wdk/moduleLoader'

/**
 * Coerce an SDK money field to a number, failing CLOSED on values that would
 * silently corrupt: `NaN`/`Infinity` (a renamed/missing field), a negative
 * value (a hostile/buggy maker returning a negative fee/amount/price that would
 * poison downstream net-amount math), or magnitudes past `Number.MAX_SAFE_INTEGER`
 * where JS would lose integer precision. Every field this coerces — amounts,
 * fees, price, expiry timestamp — is non-negative by definition. Money must
 * never flow through as a quietly-wrong number.
 */
function toAmount(value: unknown, field: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    throw new ProtocolError(`Swap response field '${field}' is not a finite number`, 'RGB_LN', 'BAD_AMOUNT')
  }
  if (n < 0) {
    throw new ProtocolError(`Swap response field '${field}' is negative`, 'RGB_LN', 'BAD_AMOUNT')
  }
  if (n > Number.MAX_SAFE_INTEGER) {
    throw new ProtocolError(`Swap response field '${field}' exceeds safe integer precision`, 'RGB_LN', 'BAD_AMOUNT')
  }
  return n
}

export interface KaleidoswapSwapConfig {
  /** KaleidoSwap maker API base URL. */
  baseUrl: string
}

/** Extended quote request carrying the layer hints the maker RFQ needs. */
export interface SwapQuoteRequest extends QuoteRequest {
  fromLayer: string
  toLayer: string
}

/**
 * Thin response shapes for the swap module's calls. These are NOT the
 * module's own types (it stays `any` at construction) — they exist so a
 * renamed/missing money field is a compile error here, not a silent `NaN`.
 */
interface RawQuote {
  rfqId: string
  tokenInAmount: number | string | bigint
  tokenOutAmount: number | string | bigint
  price: number | string
  fee: number | string | bigint
  expiresAt: number | string
}
interface RawSwap {
  paymentHash: string
  swapstring?: string
  accessToken?: string | null
  status?: string
  tokenInAmount: number | string | bigint
  tokenOutAmount: number | string | bigint
}
interface RawAtomicSwap {
  payment_hash?: string
  status?: string
  qty_from?: number | string
  qty_to?: number | string
  from_asset?: string | null
  to_asset?: string | null
}

export class KaleidoswapSwap {
  private proto: any = null
  /**
   * In-memory fallback for per-swap status access tokens (paymentHash → token).
   * Hosts should persist `SwapResult.accessToken` themselves — this map does
   * not survive process/service-worker restarts.
   */
  private accessTokens = new Map<string, string>()

  /**
   * @param account a connected WDK RLN account (whitelists the swap HTLC on the
   *        taker's node). Passed straight through to the swap module; held as `any`.
   */
  constructor(private account: any, private config: KaleidoswapSwapConfig) {}

  private async ensure(): Promise<any> {
    if (this.proto) return this.proto
    // @ts-ignore — declared as a workspace/optional dep; resolved at runtime.
    const mod = await loadWdkModule('@kaleidorg/wdk-protocol-swap-kaleidoswap', () => import('@kaleidorg/wdk-protocol-swap-kaleidoswap'))
    const KaleidoswapProtocol = mod.default ?? mod
    this.proto = new KaleidoswapProtocol(this.account, { baseUrl: this.config.baseUrl })
    return this.proto
  }

  async getQuote(req: SwapQuoteRequest): Promise<Quote> {
    if (req.fromAmount == null) {
      throw new ProtocolError('Swap quote requires fromAmount', 'RGB_LN', 'NO_AMOUNT')
    }
    const proto = await this.ensure()
    const q: RawQuote = await proto.quoteSwap({
      fromAssetId: req.fromAsset,
      toAssetId: req.toAsset,
      fromLayer: req.fromLayer,
      toLayer: req.toLayer,
      fromAmount: req.fromAmount,
    })
    return {
      id: q.rfqId,
      fromAsset: req.fromAsset,
      fromAmount: toAmount(q.tokenInAmount, 'tokenInAmount'),
      toAsset: req.toAsset,
      toAmount: toAmount(q.tokenOutAmount, 'tokenOutAmount'),
      price: toAmount(q.price, 'price'),
      fee: { amount: toAmount(q.fee, 'fee'), asset: req.fromAsset },
      expiresAt: toAmount(q.expiresAt, 'expiresAt') * 1000,
      provider: 'kaleidoswap',
    }
  }

  /**
   * Execute an approved quote as an atomic swap. The maker binds execution to
   * the quote's rfqId and the exact raw amounts passed here — there is no
   * server-side re-quote, so both legs settle at what the user approved or
   * the swap fails/expires with no funds moved.
   */
  async executeSwap(quote: Quote): Promise<SwapResult> {
    if (!quote?.id) {
      throw new ProtocolError('Swap execution requires the approved quote (with its rfq id)', 'RGB_LN', 'NO_QUOTE')
    }
    if (!(quote.fromAmount > 0) || !(quote.toAmount > 0)) {
      throw new ProtocolError('Swap execution requires the approved quote amounts', 'RGB_LN', 'NO_AMOUNT')
    }
    if (quote.expiresAt > 0 && Date.now() > quote.expiresAt) {
      throw new ProtocolError('Approved quote has expired — request a fresh quote', 'RGB_LN', 'QUOTE_EXPIRED')
    }
    const proto = await this.ensure()
    const r: RawSwap = await proto.swap({
      rfqId: quote.id,
      fromAssetId: quote.fromAsset,
      toAssetId: quote.toAsset,
      tokenInAmount: quote.fromAmount,
      tokenOutAmount: quote.toAmount,
    })
    if (r.paymentHash && r.accessToken) this.accessTokens.set(r.paymentHash, r.accessToken)
    return {
      swapId: r.paymentHash,
      paymentHash: r.paymentHash,
      accessToken: r.accessToken ?? undefined,
      status: mapAtomicStatus(r.status),
      quote: {
        ...quote,
        fromAmount: toAmount(r.tokenInAmount, 'tokenInAmount'),
        toAmount: toAmount(r.tokenOutAmount, 'tokenOutAmount'),
      },
      timestamp: Date.now(),
    }
  }

  /** Poll an atomic swap by its payment hash. */
  async getSwapStatus(paymentHash: string, accessToken?: string): Promise<SwapResult> {
    const proto = await this.ensure()
    const token = accessToken ?? this.accessTokens.get(paymentHash) ?? ''
    const s: RawAtomicSwap = await proto.getOrderStatus(paymentHash, token)
    return {
      swapId: s?.payment_hash ?? paymentHash,
      paymentHash: s?.payment_hash ?? paymentHash,
      status: mapAtomicStatus(s?.status),
      quote: {
        id: s?.payment_hash ?? paymentHash,
        fromAsset: s?.from_asset ?? '',
        fromAmount: toAmount(s?.qty_from ?? 0, 'qty_from'),
        toAsset: s?.to_asset ?? '',
        toAmount: toAmount(s?.qty_to ?? 0, 'qty_to'),
        price: 0,
        fee: { amount: 0, asset: s?.from_asset ?? '' },
        expiresAt: 0,
        provider: 'kaleidoswap',
      },
      timestamp: Date.now(),
    }
  }
}

/**
 * Atomic swap statuses: Waiting → Pending → Succeeded | Expired | Failed.
 * Anything unrecognized maps to 'pending' (fail-safe: never report success
 * for a status we don't know).
 */
function mapAtomicStatus(s?: string): SwapResult['status'] {
  switch (s) {
    case 'Succeeded':
      return 'confirmed'
    case 'Failed':
    case 'Expired':
      return 'failed'
    default:
      return 'pending'
  }
}
