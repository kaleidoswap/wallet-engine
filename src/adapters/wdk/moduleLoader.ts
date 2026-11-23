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
/** Set once every host registration is done; later writes are refused. */
let sealed = false

/** Host registers how to load a WDK package (e.g. `() => require('@tetherto/wdk-wallet-spark')`). */
export function registerWdkModule(pkgName: string, loader: WdkModuleLoader): void {
  if (sealed) {
    throw new Error(
      `WDK module registry is sealed: cannot register '${pkgName}' after sealWdkModuleRegistry() was called. ` +
        'Hosts must register every module before the wallet connects.',
    )
  }
  registry.set(pkgName, loader)
}

/**
 * Seal the registry so no later code can substitute a WDK module.
 * Call after the host's boot-time registrations; adapters refuse to
 * connect before it, so the load path a seed flows into is fixed
 * by the time any key material is passed to a module.
 */
export function sealWdkModuleRegistry(): void {
  sealed = true
}

/** Testing only: unseal. Not exported through the package barrel. */
export function unsealWdkModuleRegistryForTests(): void {
  sealed = false
  registry.clear()
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
