import { BaseBarkAdapter } from './BaseBarkAdapter.js'
import { barkClientManager } from '../lib/bark-client-manager.js'

/** Browser/WASM Bark adapter. React Native has its own opt-in entry point. */
export class BarkAdapter extends BaseBarkAdapter {
  constructor() { super(barkClientManager) }
}
