/**
 * format
 * ------
 * Amount-formatting helpers + the `Layer` union re-exported from `kaleido-sdk`,
 * so consumers (the extension's swap UI, route handlers) import them through the
 * engine and never depend on `kaleido-sdk` directly. Opt-in sub-path export:
 * `@kaleidorg/wallet-engine/format`. Kept off the SDK-free root barrel.
 */
export { toDisplayAmount, parseRawAmount } from 'kaleido-sdk'
export type { Layer } from 'kaleido-sdk'
