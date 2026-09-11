/**
 * Swap venues — sub-path export `@kaleidorg/wallet-engine/swap`. Both load their SDK
 * through the WDK module loader, so they stay out of the adapter-free main barrel.
 *
 *  - `KaleidoswapSwap`  — RFQ rail (maker `/api/v1`, settled over RLN). Owns RGB.
 *  - `BoltzChainSwap`   — BTC <-> L-BTC chain swaps (maker `/v2`, Boltz protocol).
 */
export {
  KaleidoswapSwap,
  type KaleidoswapSwapConfig,
  type SwapQuoteRequest,
} from './KaleidoswapSwap'

export {
  KaleidoswapSwapStore,
  type KaleidoswapSwapRecord,
  type KaleidoswapSwapState,
} from './kaleidoswap-swap-store'

export {
  BoltzChainSwap,
  nextPhase,
  type BoltzChainSwapConfig,
  type CreateChainSwapParams,
} from './BoltzChainSwap'

export {
  BoltzChainSwapStore,
  type BoltzChainAsset,
  type BoltzChainSwapPhase,
  type BoltzChainSwapRecord,
} from './boltz-swap-store'

export {
  ArkadeIntentsStore,
  type ArkadeIntentsRecord,
} from './arkade-intents-store'

export {
  boltzSwapClientManager,
  resolveBoltzBaseUrl,
  type BoltzClientConfig,
  type BoltzNetwork,
} from '../lib/boltz-swap-client-manager'
