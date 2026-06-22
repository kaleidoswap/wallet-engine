/**
 * Native protocol *operation* capability manifest (GL #68).
 *
 * This is the operation-level list that backs `IProtocolAdapter.capabilities`:
 * a static set of operation strings each protocol supports, known before the
 * adapter connects so the UI can gate actions without per-call-site network
 * checks. Ported from rate-extension/src/protocols/protocol-capabilities.ts.
 *
 * NOTE: this is distinct from the *differences-as-data* manifest in
 * `./capabilities` (`PROTOCOL_CAPABILITIES` / `ProtocolCapabilities`), which the
 * cross-protocol router and lite/advanced UI read for behavioural quirks
 * (zeroFee, boarding, wdkModule, …). Keep the two separate:
 *  - operation list (here) → "what actions can I offer?"  (adapter.capabilities)
 *  - data manifest (./capabilities) → "how does this protocol behave?" (router)
 *
 * Provider-routed features (swaps) live outside this manifest — a swap venue
 * may run over multiple protocols without each adapter implementing it.
 */

import type { ProtocolType } from './types/base'

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

export const PROTOCOL_OPERATION_CAPABILITIES: Record<ProtocolType, readonly ProtocolCapability[]> = {
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
  LIQUID: [
    'onchain-send',
    'onchain-receive',
    'asset-send',
    'asset-receive',
  ],
  BTC: ['onchain-send', 'onchain-receive'],
}

export function getProtocolCapabilities(protocol: ProtocolType): readonly ProtocolCapability[] {
  return PROTOCOL_OPERATION_CAPABILITIES[protocol] ?? []
}

export function protocolSupports(protocol: ProtocolType, capability: ProtocolCapability): boolean {
  return getProtocolCapabilities(protocol).includes(capability)
}
