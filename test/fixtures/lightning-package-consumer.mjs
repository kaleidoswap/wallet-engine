import * as root from '@kaleidoswap/wallet-engine'
import * as lightning from '@kaleidoswap/wallet-engine/lightning'
import { NwcLightningPayments } from '@kaleidoswap/wallet-engine/lightning/nwc'
import { RlnLightningPayments } from '@kaleidoswap/wallet-engine/lightning/rln'

if (typeof lightning.parseMsat !== 'function') throw new Error('./lightning is missing parseMsat')
if (typeof lightning.validateBolt11Invoice !== 'function') {
  throw new Error('./lightning is missing validateBolt11Invoice')
}
if (root.parseMsat !== lightning.parseMsat) throw new Error('root and ./lightning exports diverge')
if (typeof NwcLightningPayments !== 'function') throw new Error('./lightning/nwc export is missing')
if (typeof RlnLightningPayments !== 'function') throw new Error('./lightning/rln export is missing')
