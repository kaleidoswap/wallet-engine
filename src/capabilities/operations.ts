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
    'lightning-send',
    'lightning-receive',
    'asset-send',
    'asset-receive',
    'arkade-onboard',
    'arkade-offboard',
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

export function getProtocolOperations(protocol: ProtocolType): readonly ProtocolCapability[] {
  return PROTOCOL_OPERATIONS[protocol] ?? []
}

export function protocolSupportsOperation(
  protocol: ProtocolType,
  capability: ProtocolCapability,
): boolean {
  return getProtocolOperations(protocol).includes(capability)
}
