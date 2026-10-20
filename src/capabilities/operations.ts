/**
 * Operation-level capability manifest.
 * ------------------------------------
 * Distinct from the differences-as-data `PROTOCOL_CAPABILITIES` in `./index.ts`:
 * this is the list of concrete *operations* each protocol natively supports,
 * exposed via `IProtocolAdapter.capabilities` so the UI can gate actions before an
 * adapter connects.
 *
 * The two are deliberately different shapes, hence the near-identical names.
 * Provider-routed features (swaps) live outside this manifest — a venue may run
 * over multiple protocols without each adapter implementing it.
 */

import type { ProtocolType } from '../types/base'

export type ProtocolCapability =
  | 'onchain-send'
  | 'onchain-receive'
  | 'lightning-send'
  | 'lightning-receive'
  | 'asset-send'
  | 'asset-receive'
  | 'rgb-invoice'
  | 'spark-transfer'
  | 'arkade-onboard'
  | 'arkade-offboard'
  | 'bark-board'
  | 'bark-offboard'
  | 'bark-exit'
  | 'liquid-pset-inspect'
  | 'liquid-pset-sign'
  | 'simplicity-compile'

export const PROTOCOL_OPERATIONS: Record<ProtocolType, readonly ProtocolCapability[]> = {
  RGB_LN: [
    'onchain-send',
    'onchain-receive',
    'lightning-send',
    'lightning-receive',
    'asset-send',
    'asset-receive',
    'rgb-invoice',
  ],
  SPARK: [
    'onchain-send',
    'onchain-receive',
    'lightning-send',
    'lightning-receive',
    'asset-send',
    'asset-receive',
    'spark-transfer',
  ],
  ARKADE: [
    'onchain-send',
    'onchain-receive',
    'asset-send',
    'asset-receive',
    'arkade-onboard',
    'arkade-offboard',
  ],
  BARK: [
    'onchain-send',
    'onchain-receive',
    'lightning-send',
    'lightning-receive',
    'bark-board',
    'bark-offboard',
    'bark-exit',
  ],
  RGB_L1: [
    'onchain-send',
    'onchain-receive',
    'asset-send',
    'asset-receive',
    'rgb-invoice',
  ],
  // Experimental PSET/Simplicity operations are NOT listed here: their real
  // availability depends on the resolved LWK binding, so the Liquid adapter derives
  // them from `account.getSimplicityCapabilities()` and appends them only when the
  // binding supports them (fail closed).
  LIQUID: [
    'onchain-send',
    'onchain-receive',
    'asset-send',
    'asset-receive',
  ],
  BTC: ['onchain-send', 'onchain-receive'],
}

/**
 * Arkade's Lightning operations. Not in the static list: they run over the
 * Arkade Intents venue, so an Arkade adapter appends them only while one is live.
 */
export const ARKADE_LIGHTNING_OPERATIONS: readonly ProtocolCapability[] = ['lightning-send', 'lightning-receive']

/**
 * Operations a protocol offers only after per-connection setup. A route that
 * needs one must find it in the connected adapter's live `capabilities`.
 */
export const CONDITIONAL_OPERATIONS: Partial<Record<ProtocolType, readonly ProtocolCapability[]>> = {
  ARKADE: ARKADE_LIGHTNING_OPERATIONS,
}

/** True unless `operation` is conditional for `protocol` and `live` lacks it. */
export function liveOperationAvailable(
  protocol: ProtocolType,
  operation: ProtocolCapability,
  live: readonly ProtocolCapability[] | undefined,
): boolean {
  if (!CONDITIONAL_OPERATIONS[protocol]?.includes(operation)) return true
  return Array.isArray(live) && live.includes(operation)
}

export function getProtocolOperations(protocol: ProtocolType): readonly ProtocolCapability[] {
  return PROTOCOL_OPERATIONS[protocol] ?? []
}

export function protocolSupportsOperation(
  protocol: ProtocolType,
  capability: ProtocolCapability,
): boolean {
  return getProtocolOperations(protocol).includes(capability)
}
