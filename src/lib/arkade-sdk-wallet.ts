/**
 * Build an Arkade wallet on `@arkade-os/sdk` directly.
 *
 * `@arkade-os/wdk` hard-pinned the SDK at 0.4.35, which held this path behind
 * per-connection `EventSource` injection and the fixes since. Identities derive
 * `WDK_COMPAT` (see `arkade-identity`), so existing wallets keep their
 * addresses — verified byte-identical against the live wallets.
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

/** Injected implementation first, then the global. `undefined` is an answer. */
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
 * `eventSource` goes to each provider rather than onto `globalThis`, which is
 * also correct for a process holding two wallets on different transports.
 */
/**
 * Flatten a connect config that may carry its settings at the top level or
 * nested under `arkadeConfig`.
 *
 * Hosts use both shapes, and the pre-SDK-direct adapter accepted either because
 * it spread `arkadeConfig` wholesale into `Wallet.create`. Reading only the top
 * level drops a nested `storage` on the floor — silently, since the wallet then
 * falls back to in-memory and loses its VTXO state on every restart.
 */
export function flattenArkadeConfig(cfg: Record<string, any>): Record<string, any> {
  const nested = (cfg.arkadeConfig ?? {}) as Record<string, any>
  const pick = (key: string): unknown => cfg[key] ?? nested[key]
  return {
    arkServerUrl: pick('arkServerUrl'),
    esploraUrl: pick('esploraUrl'),
    indexerUrl: pick('indexerUrl'),
    swapProviderUrl: pick('swapProviderUrl'),
    delegatorUrl: pick('delegatorUrl'),
    delegationEnabled: pick('delegationEnabled'),
    boltzSwapsEnabled: pick('boltzSwapsEnabled'),
    storage: pick('storage'),
    eventSource: pick('eventSource'),
  }
}

export async function createArkadeSdkWallet(
  sdk: ArkadeWalletSdk,
  options: ArkadeSdkWalletOptions,
): Promise<CreatedArkadeWallet> {
  const eventSource = resolveEventSourceFactory(options.eventSource)
  const sse = eventSource ? { eventSource } : undefined
  // Backstop: an SDK below the peer floor ignores the per-provider option
  // silently, and silently here means VTXOs expire.
  if (options.eventSource) ensureEventSource(options.eventSource)

  const identityKey = deriveArkadeIdentityKey(options.secret, {
    derivation: options.derivation ?? 'WDK_COMPAT',
    network: options.network,
    index: options.accountIndex ?? 0,
  })

  const { storage, persistent } = resolveArkadeStorage(sdk, options.storage)

  const config: Record<string, unknown> = {
    identity: sdk.SingleKey.fromPrivateKey(identityKey),
    storage,
    // Explicit providers: the deprecated URL fields cannot carry `eventSource`.
    arkProvider: new sdk.RestArkProvider(options.arkServerUrl, sse),
  }
  if (options.indexerUrl && sdk.RestIndexerProvider) {
    config.indexerProvider = new sdk.RestIndexerProvider(options.indexerUrl, sse)
  }
  if (options.esploraUrl && sdk.EsploraProvider) {
    config.onchainProvider = new sdk.EsploraProvider(options.esploraUrl)
  }

  // On by default once configured; not delegating means funds expiring.
  // `delegateProvider` is canonical, `delegatorProvider` its deprecated alias.
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
