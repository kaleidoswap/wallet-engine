/**
 * KaleidoswapSwap
 * ---------------
 * Wraps the WDK Kaleidoswap swap protocol module (@kaleidorg/wdk-protocol-swap-kaleidoswap)
 * behind domain `Quote`/`SwapResult` types. This is the cross-asset swap path (RFQ via the
 * maker) — distinct from the lower-level cross-L2 atomic (VHTLC/Boltz) layer in types/cross-l2.
 *
 * The swap module is bound to an account (it needs a wallet to settle legs) + a baseUrl.
 * No WDK/kaleido-sdk types cross this boundary.
 */

import { Quote, QuoteRequest, SwapResult, ProtocolError } from '../types/base'
import { loadWdkModule } from '../adapters/wdk/moduleLoader'

/**
 * Coerce an SDK money field to a number, failing CLOSED on values that would
 * silently corrupt: `NaN`/`Infinity` (a renamed/missing field), or magnitudes
 * past `Number.MAX_SAFE_INTEGER` where JS would lose integer precision. Money
 * must never flow through as a quietly-wrong number.
 */
function toAmount(value: unknown, field: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    throw new ProtocolError(`Swap response field '${field}' is not a finite number`, 'RGB', 'BAD_AMOUNT')
  }
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    throw new ProtocolError(`Swap response field '${field}' exceeds safe integer precision`, 'RGB', 'BAD_AMOUNT')
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

export interface SwapExecuteRequest extends SwapQuoteRequest {
  /** Destination address/invoice for the OUTPUT asset. */
  receiverAddress: string
  /** Format of the receiver address (e.g. 'RGB_INVOICE', 'BOLT11', 'BTC_ADDRESS'). */
  receiverAddressFormat: string
}

/**
 * Thin response shapes for the swap module's RFQ calls. These are NOT the
 * module's own types (it stays `any` at construction) — they exist so a
 * renamed/missing money field is a compile error here, not a silent `NaN`.
 */
interface RawQuote {
  rfqId: string
  tokenInAmount: number | string
  tokenOutAmount: number | string
  price: number | string
  fee: number | string
  expiresAt: number | string
}
interface RawSwap {
  orderId: string
  tokenInAmount: number | string
  tokenOutAmount: number | string
  price?: number | string
  fee: number | string
  depositAddress?: string | null
  depositAddressFormat?: string | null
}
interface RawOrderStatus {
  id: string
  status?: string
  rfq_id?: string
  price?: number | string
  from_asset?: { asset_id?: string; amount?: number | string }
  to_asset?: { asset_id?: string; amount?: number | string }
}

export class KaleidoswapSwap {
  private proto: any = null

  /**
   * @param account a connected WDK account (e.g. the RLN account that settles RGB-LN legs).
   *        Passed straight through to the swap module; held as `any`.
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
      throw new ProtocolError('Swap quote requires fromAmount', 'RGB', 'NO_AMOUNT')
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

  async executeSwap(req: SwapExecuteRequest): Promise<SwapResult & { depositAddress: string | null; depositAddressFormat: string | null }> {
    if (req.fromAmount == null) {
      throw new ProtocolError('Swap requires fromAmount', 'RGB', 'NO_AMOUNT')
    }
    const proto = await this.ensure()
    const r: RawSwap = await proto.swap({
      fromAssetId: req.fromAsset,
      toAssetId: req.toAsset,
      fromLayer: req.fromLayer,
      toLayer: req.toLayer,
      fromAmount: req.fromAmount,
      receiverAddress: req.receiverAddress,
      receiverAddressFormat: req.receiverAddressFormat,
    })
    return {
      swapId: r.orderId,
      status: 'pending',
      quote: {
        id: r.orderId,
        fromAsset: req.fromAsset,
        fromAmount: toAmount(r.tokenInAmount, 'tokenInAmount'),
        toAsset: req.toAsset,
        toAmount: toAmount(r.tokenOutAmount, 'tokenOutAmount'),
        // Carry the executed price through when the maker returns it (was dropped to 0).
        price: r.price != null ? toAmount(r.price, 'price') : 0,
        fee: { amount: toAmount(r.fee, 'fee'), asset: req.fromAsset },
        expiresAt: 0,
        provider: 'kaleidoswap',
      },
      timestamp: Date.now(),
      depositAddress: r.depositAddress ?? null,
      depositAddressFormat: r.depositAddressFormat ?? null,
    }
  }

  async getSwapStatus(orderId: string): Promise<SwapResult> {
    const proto = await this.ensure()
    const o: RawOrderStatus = await proto.getOrderStatus(orderId)
    const status = mapOrderStatus(o?.status)
    return {
      swapId: o.id,
      status,
      quote: {
        id: o.rfq_id ?? o.id,
        fromAsset: o.from_asset?.asset_id ?? '',
        fromAmount: toAmount(o.from_asset?.amount ?? 0, 'from_asset.amount'),
        toAsset: o.to_asset?.asset_id ?? '',
        toAmount: toAmount(o.to_asset?.amount ?? 0, 'to_asset.amount'),
        price: toAmount(o.price ?? 0, 'price'),
        fee: { amount: 0, asset: o.from_asset?.asset_id ?? '' },
        expiresAt: 0,
        provider: 'kaleidoswap',
      },
      timestamp: Date.now(),
    }
  }
}

function mapOrderStatus(s?: string): SwapResult['status'] {
  switch (s) {
    case 'FILLED':
      return 'confirmed'
    case 'FAILED':
    case 'EXPIRED':
    case 'CANCELLED':
      return 'failed'
    default:
      return 'pending'
  }
}
