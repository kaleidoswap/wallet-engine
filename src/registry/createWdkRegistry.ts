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
import { ArkadeWdkAdapter } from '../adapters/wdk/ArkadeWdkAdapter'
import { ProtocolType } from '../types/base'

export interface WdkRegistryOptions {
  /** Which protocols to register (default: all four). */
  enabled?: ProtocolType[]
}

const ALL: ProtocolType[] = ['SPARK', 'LIQUID', 'RGB', 'ARKADE']

export function createWdkRegistry(opts: WdkRegistryOptions = {}): ProtocolAdapterRegistry {
  const enabled = opts.enabled ?? ALL
  const registry = new ProtocolAdapterRegistry()
  if (enabled.includes('SPARK')) registry.register(new SparkWdkAdapter())
  if (enabled.includes('LIQUID')) registry.register(new LiquidWdkAdapter())
  if (enabled.includes('RGB')) registry.register(new RlnWdkAdapter())
  if (enabled.includes('ARKADE')) registry.register(new ArkadeWdkAdapter())
  return registry
}
