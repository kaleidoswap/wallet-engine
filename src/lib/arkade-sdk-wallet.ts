/**
 * Build an Arkade wallet on `@arkade-os/sdk` directly, with no `@arkade-os/wdk`.
 *
 * `@arkade-os/wdk@0.1.4` — the latest published — hard-pins `@arkade-os/sdk` at
 * exactly `0.4.35`, so everything the SDK has learned since is out of reach
 * behind it: per-connection `EventSource` injection, the delegator fixes, and
 * whatever fixes the two-wallet scalar bug that 0.4.35 still has. The reference
 * wallet (`arkade-os/wallet`) uses the SDK directly and no WDK at all.
 *
 * Going direct also ends a version mix we were living with: the WDK built the
 * `Wallet` from its own 0.4.35, while `onboard`/`offboard` handed that instance
 * to a `Ramps` resolved from the top-level 0.4.72 — 37 patch releases apart,
 * on the path that moves funds on-chain.
 *
 * The identity is derived `WDK_COMPAT` (see `arkade-identity`), so **every
 * existing wallet keeps its addresses**. That equivalence is verified
 * byte-for-byte against the live mutinynet wallets; it is the whole reason this
 * move is safe to make at all.
 */

import { ensureEventSource } from './arkade-eventsource'
import { deriveArkadeIdentityKey, type ArkadeDerivation } from './arkade-identity'
import {
  NON_PERSISTENT_STORAGE_REASON,
  resolveArkadeStorage,
  type ArkadeStorage,
  type ArkadeStorageSdk,
} from './arkade-storage'

/** Opens an SSE stream for a URL — `new EventSource(url)`, as a value. */
export type EventSourceFactory = (url: string) => unknown

/** The slice of the SDK namespace this module constructs from. */
export interface ArkadeWalletSdk extends ArkadeStorageSdk {
  Wallet: { create(config: Record<string, unknown>): Promise<unknown> }
  SingleKey: { fromPrivateKey(key: Uint8Array): unknown }
  RestArkProvider: new (url?: string, opts?: { eventSource?: EventSourceFactory }) => unknown
  RestIndexerProvider?: new (url?: string, opts?: { eventSource?: EventSourceFactory }) => unknown
  EsploraProvider?: new (url?: string) => unknown
  RestDelegatorProvider?: new (url: string) => unknown
}

export interface ArkadeSdkWalletOptions {
  /** Mnemonic, `nsec1…` or 64-char hex — whatever `resolveWalletSeed` accepts. */
  secret: string
  network?: string
  accountIndex?: number
  derivation?: ArkadeDerivation
  arkServerUrl?: string
  esploraUrl?: string
  indexerUrl?: string
  delegatorUrl?: string
  delegationEnabled?: boolean
  storage?: ArkadeStorage
  /** `EventSource` implementation for runtimes without the global. */
  eventSource?: unknown
}

export interface CreatedArkadeWallet {
  wallet: any
  /** False when VTXO/contract rows are in-memory and reset on every connect. */
  storagePersistent: boolean
  /** True when a delegator will renew this wallet's VTXOs on its behalf. */
  delegationEnabled: boolean
  /** False when no SSE transport could be resolved — settlement is impossible. */
  eventSourceAvailable: boolean
}

/**
 * Resolve how this connection opens an SSE stream.
 *
 * Injected implementation first, then the runtime's global. Returning
 * `undefined` is a real answer — the caller reports it rather than letting the
 * SDK discover it one failed settle at a time.
 */
export function resolveEventSourceFactory(injected?: unknown): EventSourceFactory | undefined {
  if (typeof injected === 'function') {
    const Impl = injected as new (url: string) => unknown
    return (url: string) => new Impl(url)
  }
  const Global = (globalThis as { EventSource?: unknown }).EventSource
  if (typeof Global === 'function') {
    const Impl = Global as new (url: string) => unknown
    return (url: string) => new Impl(url)
  }
  return undefined
}

/**
 * Create the SDK wallet, its providers, its storage and its delegator.
 *
 * `eventSource` is handed to each provider rather than assigned onto
 * `globalThis`: 0.4.72 takes it per connection, which is both cleaner than
 * mutating a global and correct for a process holding two wallets that need
 * different transports.
 */
export async function createArkadeSdkWallet(
  sdk: ArkadeWalletSdk,
  options: ArkadeSdkWalletOptions,
): Promise<CreatedArkadeWallet> {
  const eventSource = resolveEventSourceFactory(options.eventSource)
  const sse = eventSource ? { eventSource } : undefined
  // Belt and braces. Per-provider injection is the mechanism, but the option is
  // silently ignored by an SDK older than the peer floor — and "silently
  // ignored" on this path means settlement stops and VTXOs expire, which is the
  // exact failure this whole change exists to end. Installing on the global
  // too costs nothing and never overwrites an implementation already there.
  if (options.eventSource) ensureEventSource(options.eventSource)

  const identityKey = deriveArkadeIdentityKey(options.secret, {
    // Never defaulted at the call site by accident: the two derivations open
    // two different wallets. See `arkade-identity`.
    derivation: options.derivation ?? 'WDK_COMPAT',
    network: options.network,
    index: options.accountIndex ?? 0,
  })

  const { storage, persistent } = resolveArkadeStorage(sdk, options.storage)

  const config: Record<string, unknown> = {
    identity: sdk.SingleKey.fromPrivateKey(identityKey),
    storage,
    // Explicit providers, not the deprecated URL fields — and the only way to
    // pass an SSE transport per connection.
    arkProvider: new sdk.RestArkProvider(options.arkServerUrl, sse),
  }
  if (options.indexerUrl && sdk.RestIndexerProvider) {
    config.indexerProvider = new sdk.RestIndexerProvider(options.indexerUrl, sse)
  }
  if (options.esploraUrl && sdk.EsploraProvider) {
    config.onchainProvider = new sdk.EsploraProvider(options.esploraUrl)
  }

  // On by default once a URL is configured: the failure mode of not delegating
  // is funds expiring. `delegateProvider` is canonical — `delegatorProvider` is
  // its deprecated alias.
  const delegationEnabled = Boolean(options.delegatorUrl) && options.delegationEnabled !== false
  if (delegationEnabled && options.delegatorUrl && sdk.RestDelegatorProvider) {
    config.delegateProvider = new sdk.RestDelegatorProvider(options.delegatorUrl)
  }

  const wallet = await sdk.Wallet.create(config)

  if (!persistent) console.warn(`[arkade] ${NON_PERSISTENT_STORAGE_REASON}`)

  return {
    wallet,
    storagePersistent: persistent,
    delegationEnabled,
    eventSourceAvailable: Boolean(eventSource),
  }
}
