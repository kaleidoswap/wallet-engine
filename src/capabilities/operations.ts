/**
 * Operation-level capability manifest.
 * --------------------------------------
 * Distinct from the differences-as-data `PROTOCOL_CAPABILITIES` record in
 * `./index.ts` (which the router and lite/advanced UI read). This manifest is
 * the list of concrete *operations* each protocol natively supports, exposed on
 * every adapter via `IProtocolAdapter.capabilities` so the UI can gate actions
 * before an adapter connects — without per-call-site network checks.
 *
 * Naming: `ProtocolCapability` / `PROTOCOL_OPERATIONS` here vs
 * `ProtocolCapabilities` / `PROTOCOL_CAPABILITIES` in `./index.ts`. The two are
 * deliberately different shapes; see the wallet-engine integration spec (A5).
 *
 * Provider-routed features (swaps) live outside this manifest — a swap venue
 * may run over multiple protocols without each adapter implementing it.
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

export const PROTOCOL_OPERATIONS: Record<ProtocolType, readonly ProtocolCapability[]> = {
  RGB: [
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
  LIQUID: ['onchain-send', 'onchain-receive', 'asset-send', 'asset-receive'],
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
