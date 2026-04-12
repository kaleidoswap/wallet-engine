/**
 * Protocol utility functions
 * Maps between database NetworkConfig types and protocol types.
 */

import { ProtocolType } from './types/base'

type NetworkType = 'spark' | 'arkade' | 'rln' | 'liquid'

export function networkTypeToProtocol(nt: NetworkType): ProtocolType | null {
  switch (nt) {
    case 'rln': return 'RGB'
    case 'spark': return 'SPARK'
    case 'arkade': return 'ARKADE'
    case 'liquid': return null // No adapter registered
    default: return null
  }
}

export function protocolToNetworkType(pt: ProtocolType): NetworkType | null {
  switch (pt) {
    case 'RGB': return 'rln'
    case 'SPARK': return 'spark'
    case 'ARKADE': return 'arkade'
    default: return null
  }
}
