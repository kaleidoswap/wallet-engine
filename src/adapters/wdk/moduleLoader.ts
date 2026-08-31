/**
 * WDK Module Loader (platform-injectable)
 * ---------------------------------------
 * WDK modules are heavy native/WASM packages, and how they load differs per host:
 * dynamic `import()` works under Node/Vite, but is unreliable under React
 * Native/Metro, where the app injects a STATIC `require()` instead.
 *
 * Adapters call `loadWdkModule(pkgName, () => import(pkgName))`: a host-registered
 * loader wins, otherwise the inline fallback runs. The fallback's specifier is a
 * string literal so bundlers can still analyze it.
 */

export type WdkModuleLoader = () => any | Promise<any>

const registry = new Map<string, WdkModuleLoader>()

/** Host registers how to load a WDK package (e.g. `() => require('@tetherto/wdk-wallet-spark')`). */
export function registerWdkModule(pkgName: string, loader: WdkModuleLoader): void {
  registry.set(pkgName, loader)
}

/** True if the host injected a loader for this package. */
export function hasWdkModule(pkgName: string): boolean {
  return registry.has(pkgName)
}

/** Resolve a WDK module via the injected loader, falling back to the inline dynamic import. */
export async function loadWdkModule(pkgName: string, fallback: () => Promise<any>): Promise<any> {
  const loader = registry.get(pkgName)
  if (loader) return await loader()
  return await fallback()
}
