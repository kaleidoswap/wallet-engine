/**
 * WDK Module Loader (platform-injectable)
 * ---------------------------------------
 * WDK modules are heavy native/WASM packages. How they're loaded differs per host:
 *  - Node / Vite (extension): dynamic `import()` works fine.
 *  - React Native / Metro: dynamic import of node_modules packages is unreliable;
 *    the app injects a STATIC `require()` instead (mirrors rate's existing
 *    `setSdkFactory` pattern for the native SDKs).
 *
 * Adapters call `loadWdkModule(pkgName, () => import(pkgName))`. If the host has
 * registered a loader for that package, it's used; otherwise the inline dynamic
 * import fallback runs. The fallback's import specifier is a string literal so
 * bundlers can still analyze it.
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
