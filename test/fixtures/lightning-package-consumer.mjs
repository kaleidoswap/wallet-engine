import * as root from '@kaleidorg/wallet-engine'
import * as lightning from '@kaleidorg/wallet-engine/lightning'

if (typeof lightning.parseMsat !== 'function') throw new Error('./lightning is missing parseMsat')
if (typeof lightning.validateBolt11Invoice !== 'function') {
  throw new Error('./lightning is missing validateBolt11Invoice')
}
if (root.parseMsat !== lightning.parseMsat) throw new Error('root and ./lightning exports diverge')
