/**
 * Kaleidoswap RFQ swap wrapper.
 *
 * Opt-in sub-path export: `@kaleidorg/wallet-engine/swap`. Uses the WDK
 * module loader, so it is kept out of the adapter-free main barrel.
 */
export {
  KaleidoswapSwap,
  type KaleidoswapSwapConfig,
  type SwapQuoteRequest,
  type SwapExecuteRequest,
} from './KaleidoswapSwap'
