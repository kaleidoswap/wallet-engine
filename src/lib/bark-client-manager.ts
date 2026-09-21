/**
 * Bark wallet lifecycle (`@secondts/bark`), shared by every host.
 *
 * The wasm module is NOT instantiated here: `@secondts/bark`'s entry does a
 * static `import * as wasm from "./bark_ffi_wasm_bg.wasm"`, which only a
 * bundler can resolve. Hosts instantiate the binary themselves and wire it
 * into the glue (`__wbg_set_wasm`) before calling `initialize()`, exactly as
 * rate-extension already does for `lwk_wasm`; this manager then
 * `import()`s the package and gets the already-initialized module back.
 *
 * Two host-side facts that are easy to get wrong:
 *   - bark reaches IndexedDB through `web_sys::window()`, an `instanceof
 *     Window` check. A service worker has no `Window` class, so the open fails
 *     with "Not running in a browser window" until the host aliases it (see
 *     `assertBarkRuntime` below, and the loader comment in the host).
 *   - `Wallet.open` does not verify the mnemonic against the stored database.
 *     Always pass an explicit per-wallet `dbName`.
 */

import type { BarkConfig, BarkMaintenanceReport } from '../types/bark'
import { WalletSessionGuard, type SessionAttempt } from './wallet-session'
import { log } from './log'

// The package ships its types with the bundler build; `import type` is erased,
// so this creates no runtime dependency for hosts that never load bark.
type BarkModule = typeof import('@secondts/bark')
// `Wallet`'s constructor is private in the bindings; take the instance
// type from the factory instead.
type BarkWallet = Awaited<ReturnType<BarkModule['Wallet']['open']>>
type BarkNetwork = 'Bitcoin' | 'Signet'

const WALLET_SLOT = 'wallet'

/** Loader override, so a host can hand over an already-resolved module. */
let moduleLoader: (() => Promise<BarkModule>) | null = null

/**
 * Point the manager at a bark module the host resolved itself. Hosts whose
 * bundler cannot follow the bare specifier (MV3 service workers, React Native)
 * call this before `initialize()`.
 */
export function setBarkModuleLoader(loader: () => Promise<BarkModule>): void {
  moduleLoader = loader
}

/** The resolved bindings, kept so address checks need no wallet. */
let loadedModule: BarkModule | null = null

async function loadBark(): Promise<BarkModule> {
  const module = moduleLoader ? await moduleLoader() : await import('@secondts/bark')
  loadedModule = module
  return module
}

function toBarkNetwork(network: BarkConfig['network']): BarkNetwork {
  return network === 'mainnet' ? 'Bitcoin' : 'Signet'
}

/**
 * Fail early and legibly on the two runtime gaps that otherwise surface deep
 * inside the wasm as "Not running in a browser window".
 */
function assertBarkRuntime(): void {
  if (typeof globalThis.indexedDB === 'undefined') {
    throw new Error('bark requires IndexedDB; this runtime has none')
  }
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    throw new Error('bark requires crypto.subtle (a secure context)')
  }
  if (typeof (globalThis as { Window?: unknown }).Window === 'undefined') {
    throw new Error(
      'bark resolves storage via `instanceof Window`, which fails in this runtime. ' +
        'Alias the class before initialize(): globalThis.Window = globalThis.constructor',
    )
  }
}

function sameBarkConfig(a: unknown, b: unknown): boolean {
  const x = a as BarkConfig | null
  const y = b as BarkConfig | null
  return (
    x?.network === y?.network &&
    x?.mnemonic === y?.mnemonic &&
    x?.arkServerUrl === y?.arkServerUrl &&
    x?.esploraUrl === y?.esploraUrl &&
    x?.dbName === y?.dbName
  )
}

class BarkClientManager {
  private wallet: BarkWallet | null = null
  private config: BarkConfig | null = null
  private readonly session = new WalletSessionGuard({
    name: 'BarkClientManager',
    sameWallet: sameBarkConfig,
    onConflict: 'reject',
    conflictError: () =>
      new Error('Bark client is already initializing with a different config. Call dispose() first.'),
  })

  initialize(config: BarkConfig): Promise<void> {
    return this.session.begin(WALLET_SLOT, config, (attempt) => this._doInitialize(config, attempt))
  }

  private async _doInitialize(config: BarkConfig, attempt: SessionAttempt): Promise<void> {
    if (this.wallet) {
      log.warn('[BarkClientManager] Wallet already initialized, re-initializing...')
      await this.dispose()
    }
    this.config = config
    attempt.mark()

    assertBarkRuntime()
    if (!config.mnemonic) throw new Error('Bark requires a BIP39 mnemonic')
    if (!config.arkServerUrl) throw new Error('Bark requires arkServerUrl')

    const bark = await loadBark()
    const started = Date.now()
    // `Wallet.open` with createIfNotExists (its default) both creates and
    // reopens — `Wallet.create` is only needed to force a rescan, and errors
    // with "cannot overwrite already existing config" on an existing database.
    const wallet = await bark.Wallet.open(
      toBarkNetwork(config.network),
      config.mnemonic,
      {
        serverAddress: config.arkServerUrl,
        esploraAddress: config.esploraUrl,
        vtxoRefreshExpiryThreshold: config.vtxoRefreshExpiryThreshold,
        userAgent: config.userAgent,
      },
      null,
      {
        // The daemon is a long-lived loop; a service-worker host drives
        // maintenance from an alarm instead and opts out here.
        runDaemon: config.runDaemon ?? false,
        indexedDbName: config.dbName,
        createIfNotExists: true,
        skipRecovery: config.skipRecovery ?? false,
      },
    )

    if (!(await attempt.claim(() => wallet.free()))) return
    this.wallet = wallet
    log.info('[BarkClientManager] Bark wallet opened in %dms', Date.now() - started)
  }

  /**
   * Whether the bindings accept this as one of THIS Ark's addresses. Arkade
   * mints under the same `tark1` HRP with a different payload, and bark's
   * validator rejects it — which is the only reliable way to tell them apart.
   * False before the module is loaded: nothing can be sent then either.
   */
  isBarkAddress(address: string): boolean {
    if (!loadedModule) return false;
    try {
      return loadedModule.validateArkAddress(address.trim());
    } catch {
      return false;
    }
  }

  getWallet(): BarkWallet {
    if (!this.wallet) throw new Error('Bark wallet not initialized. Call initialize() first.')
    return this.wallet
  }

  isInitialized(): boolean {
    return this.wallet !== null
  }

  /** Connected config with the mnemonic REDACTED. */
  getConfig(): BarkConfig | null {
    return this.config ? { ...this.config, mnemonic: '' } : null
  }

  async dispose(): Promise<void> {
    this.session.invalidate()
    const wallet = this.wallet
    this.wallet = null
    this.config = null
    try {
      wallet?.free()
    } catch (error) {
      log.warn('[BarkClientManager] free() failed:', error)
    }
  }

  /**
   * One periodic tick for a host with no long-lived process: sync, refresh
   * what is close to expiry, and push any round this wallet already joined
   * one step further.
   *
   * A round the wallet joined before it was evicted stays in the database and
   * its VTXO reads as `pendingInRound` — spendable balance drops to zero until
   * the round completes — so a host that never calls this leaves funds frozen
   * until the next user-triggered operation.
   */
  async runMaintenance(): Promise<BarkMaintenanceReport> {
    const wallet = this.getWallet()
    const started = Date.now()
    await wallet.sync()
    await wallet.maintenance()
    await wallet.progressPendingRounds()

    const [toRefresh, pendingRounds, claimableExits, nextRequiredRefreshHeight] = await Promise.all([
      wallet.getVtxosToRefresh(),
      wallet.pendingRoundStates(),
      wallet.listClaimableExits(),
      wallet.getNextRequiredRefreshBlockheight(),
    ])

    let refreshed: string[] = []
    if (toRefresh.length > 0) {
      const ids = toRefresh.map((vtxo: { id: string }) => vtxo.id)
      // Delegated refresh hands the round to the server, so it completes even
      // if this host is evicted before the next round starts.
      await wallet.refreshVtxosDelegated(ids)
      refreshed = ids
    }

    return {
      syncedMs: Date.now() - started,
      refreshed,
      pendingRounds: pendingRounds.length,
      claimableExits: claimableExits.length,
      nextRequiredRefreshHeight,
    }
  }
}

export const barkClientManager = new BarkClientManager()
