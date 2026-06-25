/**
 * WDK Registry Factory
 * --------------------
 * Convenience: build a `ProtocolAdapterRegistry` populated with the WDK-backed
 * adapters. Opt-in — apps may instead register adapters selectively to keep bundles
 * lean. Importing this pulls only the thin adapter wrappers; the heavy WDK modules
 * are loaded lazily inside each adapter's `connect()` (dynamic import), so this does
 * NOT eagerly bundle the WDK modules.
 *
 * Adapters are constructed but NOT connected — call `connect(config)` per protocol
 * (each adapter's config carries its mnemonic + protocol-specific endpoints).
 */

import { ProtocolAdapterRegistry } from '../adapters/IProtocolAdapter'
import { SparkWdkAdapter } from '../adapters/wdk/SparkWdkAdapter'
import { LiquidWdkAdapter } from '../adapters/wdk/LiquidWdkAdapter'
import { RlnWdkAdapter } from '../adapters/wdk/RlnWdkAdapter'
import { RgbLibWdkAdapter } from '../adapters/wdk/RgbLibWdkAdapter'
import { RgbLibWasmAdapter } from '../adapters/wdk/RgbLibWasmAdapter'
import { ArkadeWdkAdapter } from '../adapters/wdk/ArkadeWdkAdapter'
import { ProtocolType } from '../types/base'

export interface WdkRegistryOptions {
  /** Which protocols to register (default: all four). */
  enabled?: ProtocolType[]
  /**
   * Which RGB_L1 backing to register when `RGB_L1` is enabled:
   *  - `'native'` (default): `RgbLibWdkAdapter` (native rgb-lib + filesystem
   *    dataDir; Node/RN/desktop only).
   *  - `'wasm'`: `RgbLibWasmAdapter` (browser/WASM rgb-lib + IndexedDB; runs
   *    node-less in an MV3 service worker).
   */
  rgbL1Backing?: 'native' | 'wasm'
}

// RGB_L1 is opt-in (not in the default set): it's an alternative to the
// node-backed RGB path, not an addition to it, and the backing is host-specific.
const ALL: ProtocolType[] = ['SPARK', 'LIQUID', 'RGB_LN', 'ARKADE']

export function createWdkRegistry(opts: WdkRegistryOptions = {}): ProtocolAdapterRegistry {
  const enabled = opts.enabled ?? ALL
  const registry = new ProtocolAdapterRegistry()
  if (enabled.includes('SPARK')) registry.register(new SparkWdkAdapter())
  if (enabled.includes('LIQUID')) registry.register(new LiquidWdkAdapter())
  if (enabled.includes('RGB_LN')) registry.register(new RlnWdkAdapter())
  if (enabled.includes('RGB_L1')) {
    registry.register(opts.rgbL1Backing === 'wasm' ? new RgbLibWasmAdapter() : new RgbLibWdkAdapter())
  }
  if (enabled.includes('ARKADE')) registry.register(new ArkadeWdkAdapter())
  return registry
}
