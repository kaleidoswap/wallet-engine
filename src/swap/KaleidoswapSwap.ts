/**
 * KaleidoswapSwap
 * ---------------
 * Wraps the WDK Kaleidoswap swap module behind domain `Quote`/`SwapResult` types:
 * the cross-asset path (RFQ via the maker, settled as an atomic HTLC swap over
 * Lightning), distinct from the cross-L2 VHTLC/Boltz layer in types/cross-l2.
 *
 * The module is bound to the taker's RLN account (which whitelists the HTLC) plus a
 * baseUrl. No WDK/kaleido-sdk types cross this boundary.
 *
 * UNITS: RAW base units throughout. The module rejects fractional inputs, so a
 * display-unit caller fails loudly instead of creating an order scaled by
 * 10^precision. Execution passes the approved quote's rfqId and exact raw amounts,
 * so a fill can never diverge from what the user approved.
 */

import { Quote, QuoteRequest, SwapResult, ProtocolError } from '../types/base'
import { loadWdkModule } from '../adapters/wdk/moduleLoader'
// Fail-closed money coercion, shared with RgbAdapter's native maker path — which
// consumes the same maker responses and used to take them raw (finding E-F4).
import {
  toSwapAmount as toAmount,
  validateSwapQuoteTerms,
} from '../lib/swap-money'
import {
  KaleidoswapSwapStore,
  kaleidoswapNow,
  type KaleidoswapSwapRecord,
} from './kaleidoswap-swap-store'

export interface KaleidoswapSwapConfig {
  /** KaleidoSwap maker API base URL. */
  baseUrl: string
  /**
   * Maximum from-leg divergence accepted from a maker quote, in basis points.
   * Defaults to 100 (1%); 0 requires an exact amount match.
   */
  maxQuoteSlippageBps?: number
  /** Stable, non-secret wallet identity used to namespace durable recovery records. */
  walletId?: string
}

/** Extended quote request carrying the layer hints the maker RFQ needs. */
export interface SwapQuoteRequest extends QuoteRequest {
  fromLayer: string
  toLayer: string
}

/**
 * Thin response shapes for the swap module's calls — NOT the module's own types.
 * They exist so a renamed/missing money field is a compile error, not a silent NaN.
 */
interface RawQuote {
  rfqId: string
  tokenInAmount: number | string | bigint
  tokenOutAmount: number | string | bigint
  price: number | string
  fee: number | string | bigint
  expiresAt: number | string
  /** Optional echoes supported by alternate module versions/test doubles. */
  fromAsset?: string
  toAsset?: string
  fromAssetId?: string
  toAssetId?: string
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
  private protoPromise: Promise<any> | null = null
  private readonly store: KaleidoswapSwapStore
  /** Hot cache only; the record store remains authoritative across restarts. */
  private readonly accessTokenCache = new Map<string, string>()

  /**
   * @param account a connected WDK RLN account (whitelists the swap HTLC on the
   *        taker's node). Passed through to the swap module; held as `any`.
   */
  constructor(private account: any, private config: KaleidoswapSwapConfig) {
    this.store = new KaleidoswapSwapStore(config.walletId)
  }

  private async ensure(): Promise<any> {
    if (this.proto) return this.proto
    if (this.protoPromise) return this.protoPromise
    const pending = (async () => {
      // @ts-ignore — declared as a workspace/optional dep; resolved at runtime.
      const mod = await loadWdkModule('@kaleidorg/wdk-protocol-swap-kaleidoswap', () => import('@kaleidorg/wdk-protocol-swap-kaleidoswap'))
      const KaleidoswapProtocol = mod.default ?? mod
      const proto = new KaleidoswapProtocol(this.account, { baseUrl: this.config.baseUrl })
      this.proto = proto
      return proto
    })()
    this.protoPromise = pending
    try {
      return await pending
    } finally {
      if (this.protoPromise === pending) this.protoPromise = null
    }
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
    const terms = validateSwapQuoteTerms(
      req,
      {
        fromAsset: q.fromAssetId ?? q.fromAsset ?? req.fromAsset,
        toAsset: q.toAssetId ?? q.toAsset ?? req.toAsset,
        fromAmount: q.tokenInAmount,
        toAmount: q.tokenOutAmount,
      },
      this.config.maxQuoteSlippageBps,
    )
    return {
      id: q.rfqId,
      fromAsset: terms.fromAsset,
      fromAmount: terms.fromAmount,
      toAsset: terms.toAsset,
      toAmount: terms.toAmount,
      price: toAmount(q.price, 'price'),
      fee: { amount: toAmount(q.fee, 'fee'), asset: req.fromAsset },
      expiresAt: toAmount(q.expiresAt, 'expiresAt') * 1000,
      provider: 'kaleidoswap',
    }
  }

  /**
   * Execute an approved quote as an atomic swap. The maker binds execution to the
   * rfqId and exact raw amounts passed here — no server-side re-quote, so both legs
   * settle at what the user approved or the swap fails with no funds moved.
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
    if (!this.store.tryClaim(quote.id)) {
      throw new ProtocolError(
        `Swap quote ${quote.id} is already executing`,
        'RGB_LN',
        'SWAP_IN_FLIGHT',
        { quoteId: quote.id },
      )
    }
    try {
      const previous = await this.store.getByQuoteId(quote.id)
      if (previous) {
        throw new ProtocolError(
          `Swap quote ${quote.id} was already used`,
          'RGB_LN',
          'SWAP_ALREADY_EXECUTED',
          { quoteId: quote.id, state: previous.state, paymentHash: previous.paymentHash },
        )
      }
      const proto = await this.ensure()
      const createdAt = kaleidoswapNow()
      await this.store.save({
        quoteId: quote.id,
        fromAsset: quote.fromAsset,
        fromAmount: quote.fromAmount,
        toAsset: quote.toAsset,
        toAmount: quote.toAmount,
        expiresAt: quote.expiresAt,
        createdAt,
        updatedAt: createdAt,
        state: 'approved',
      })
      await this.store.update(quote.id, { state: 'executing', updatedAt: kaleidoswapNow() })
      let r: RawSwap
      try {
        r = await proto.swap({
          rfqId: quote.id,
          fromAssetId: quote.fromAsset,
          toAssetId: quote.toAsset,
          tokenInAmount: quote.fromAmount,
          tokenOutAmount: quote.toAmount,
        })
      } catch (error) {
        await this.store.update(quote.id, { state: 'execution_unknown', updatedAt: kaleidoswapNow() })
        throw error
      }
      await this.store.update(quote.id, {
        paymentHash: r.paymentHash,
        accessToken: r.accessToken ?? undefined,
        state: mapAtomicStatus(r.status),
        updatedAt: kaleidoswapNow(),
      })
      if (r.paymentHash && r.accessToken) this.accessTokenCache.set(r.paymentHash, r.accessToken)
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
        timestamp: kaleidoswapNow(),
      }
    } finally {
      this.store.releaseClaim(quote.id)
    }
  }

  /** Poll an atomic swap by its payment hash. */
  async getSwapStatus(paymentHash: string, accessToken?: string): Promise<SwapResult> {
    const proto = await this.ensure()
    const record = await this.store.find(paymentHash)
    const token = accessToken ?? record?.accessToken ?? this.accessTokenCache.get(paymentHash) ?? ''
    const s: RawAtomicSwap = await proto.getOrderStatus(paymentHash, token)
    const status = mapAtomicStatus(s?.status)
    if (record) {
      await this.store.update(record.quoteId, { state: status, updatedAt: kaleidoswapNow() })
    }
    return {
      swapId: s?.payment_hash ?? paymentHash,
      paymentHash: s?.payment_hash ?? paymentHash,
      accessToken: accessToken ?? record?.accessToken,
      status,
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
      timestamp: kaleidoswapNow(),
    }
  }

  /** Enumerate durable records that have not reached a terminal maker state. */
  async listIncompleteSwaps(): Promise<KaleidoswapSwapRecord[]> {
    return this.store.listIncomplete()
  }

  /** Resume status inspection by either the RFQ id or payment hash. */
  async resumeSwap(identifier: string, accessToken?: string): Promise<SwapResult> {
    const record = await this.store.find(identifier)
    if (!record?.paymentHash) {
      throw new ProtocolError(
        `Swap ${identifier} has no payment hash and can only be inspected`,
        'RGB_LN',
        'SWAP_RECOVERY_UNAVAILABLE',
        { quoteId: record?.quoteId ?? identifier },
      )
    }
    return this.getSwapStatus(record.paymentHash, accessToken)
  }
}

/**
 * Atomic swap statuses: Waiting → Pending → Succeeded | Expired | Failed. Anything
 * unrecognized maps to 'pending' — never report success for an unknown status.
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
