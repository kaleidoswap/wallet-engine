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
    const q: any = await proto.quoteSwap({
      fromAssetId: req.fromAsset,
      toAssetId: req.toAsset,
      fromLayer: req.fromLayer,
      toLayer: req.toLayer,
      fromAmount: req.fromAmount,
    })
    return {
      id: q.rfqId,
      fromAsset: req.fromAsset,
      fromAmount: Number(q.tokenInAmount),
      toAsset: req.toAsset,
      toAmount: Number(q.tokenOutAmount),
      price: Number(q.price),
      fee: { amount: Number(q.fee), asset: req.fromAsset },
      expiresAt: Number(q.expiresAt) * 1000,
      provider: 'kaleidoswap',
    }
  }

  async executeSwap(req: SwapExecuteRequest): Promise<SwapResult & { depositAddress: string | null; depositAddressFormat: string | null }> {
    if (req.fromAmount == null) {
      throw new ProtocolError('Swap requires fromAmount', 'RGB', 'NO_AMOUNT')
    }
    const proto = await this.ensure()
    const r: any = await proto.swap({
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
        fromAmount: Number(r.tokenInAmount),
        toAsset: req.toAsset,
        toAmount: Number(r.tokenOutAmount),
        price: 0,
        fee: { amount: Number(r.fee), asset: req.fromAsset },
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
    const o: any = await proto.getOrderStatus(orderId)
    const status = mapOrderStatus(o?.status)
    return {
      swapId: o.id,
      status,
      quote: {
        id: o.rfq_id,
        fromAsset: o.from_asset?.asset_id,
        fromAmount: Number(o.from_asset?.amount ?? 0),
        toAsset: o.to_asset?.asset_id,
        toAmount: Number(o.to_asset?.amount ?? 0),
        price: Number(o.price ?? 0),
        fee: { amount: 0, asset: o.from_asset?.asset_id },
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
