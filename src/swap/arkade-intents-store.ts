/**
 * Arkade Intents swap store
 * -------------------------
 * Persists the venue's recovery records through the `IStorageProvider` seam, so they
 * survive a service-worker eviction on every host without the engine owning any
 * IndexedDB code.
 *
 * This store is the safety line: a corridor record is written BEFORE the lockup is
 * funded, and a record lost after funding is a VHTLC the wallet can no longer
 * rebuild. Records are plain JSON by the venue's own guarantee, so a bare
 * `JSON.stringify` round-trips them exactly — no tagged bigint encoding, unlike the
 * Boltz chain-swap store.
 *
 * Canonical types live in `@kaleidorg/swap-sdk/arkade`; the engine mirrors the
 * structural subset it relies on so this compiles against any installed version.
 */

import { getPlatform, type IStorageProvider } from '../ports'
import { ProtocolError } from '../types/base'

/** Venue phases with live records — everything else is terminal. */
const PENDING_PHASES = new Set(['prepared', 'funded'])

/**
 * Structural subset of the venue's `ArkadeSwapRecord`. The venue reads and writes
 * whole records; the store only inspects `id` and `phase`.
 */
export interface ArkadeIntentsRecord {
  /** The rfq_id — the record key. */
  id: string
  /** Venue phase: prepared | funded | settled | refunded | cancelled | failed | needs_recovery. */
  phase: string
  [key: string]: unknown
}

const ROOT = 'arkade:intents:'

/** Which wallet on which Ark network a store belongs to. */
export interface ArkadeIntentsStoreScope {
  network: string
  /** The wallet identity's x-only pubkey, hex. */
  walletId: string
}

/**
 * Written by the engine right before it funds a send lockup, and updated with
 * the txid once the funding call returns. Its presence means "treat as funded":
 * the venue's own record can still read `prepared` (or `cancelled`) when the
 * hand-off to the venue was lost.
 */
export interface ArkadeIntentsFundingMarker {
  /** Unix seconds. */
  startedAt: number
  fundingTxid?: string
  /** The funding call threw: the lockup may or may not have been funded. */
  error?: string
}

/**
 * Runs `fn` while holding the lock `name`. Must exclude every context that
 * shares the store's storage, not just this process.
 */
export type ArkadeIntentsFundingLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>

/**
 * The Web Locks API, when the runtime has one. Its locks are per origin, so an
 * extension's popup and its service worker exclude each other. Null elsewhere
 * (React Native, older Node).
 */
export function webFundingLock(): ArkadeIntentsFundingLock | null {
  const locks = (globalThis as { navigator?: { locks?: { request?: unknown } } }).navigator?.locks
  if (!locks || typeof locks.request !== 'function') return null
  const request = locks.request.bind(locks) as (name: string, fn: () => Promise<unknown>) => Promise<unknown>
  return <T>(name: string, fn: () => Promise<T>) => request(name, fn) as Promise<T>
}

/** x-only form of a 32- or 33-byte hex pubkey, lowercased. */
function xOnlyHex(key: unknown): string | undefined {
  if (typeof key !== 'string') return undefined
  const k = key.toLowerCase()
  if (/^[0-9a-f]{64}$/.test(k)) return k
  if (/^0[23][0-9a-f]{64}$/.test(k)) return k.slice(2)
  return undefined
}

/**
 * Whether `record` was quoted for the wallet with x-only key `walletId`: the
 * venue puts the wallet's identity key on the trader's own leg of the VHTLC
 * (the sender on a send, the receiver on a receive).
 */
export function recordBelongsTo(record: ArkadeIntentsRecord, walletId: string): boolean {
  const id = walletId.toLowerCase()
  const options = (record.scriptOptions ?? {}) as Record<string, unknown>
  const own = record.route === 'lightning:BTC->arkade:BTC' ? options.receiverHex : options.senderHex
  if (xOnlyHex(own) === id) return true
  const descriptor = (record.secrets as { signingDescriptor?: unknown } | undefined)?.signingDescriptor
  return typeof descriptor === 'string' && descriptor.toLowerCase().includes(id)
}

function scopeKey(scope: ArkadeIntentsStoreScope): string {
  if (!scope.network || !scope.walletId || /:/.test(scope.network + scope.walletId)) {
    throw new ProtocolError('Arkade Intents store scope needs a network and a wallet id', 'ARKADE', 'CONFIG')
  }
  return `${ROOT}${scope.network}:${scope.walletId.toLowerCase()}:`
}

/**
 * `IStorageProvider`-backed implementation of the venue's `ArkadeSwapStore` port.
 * Scoped stores key records under `arkade:intents:<network>:<walletId>:swap:<rfq_id>`,
 * so two wallets (or networks) on one host never see each other's swaps. The
 * unscoped form (`arkade:intents:swap:<rfq_id>`) is what releases before
 * per-wallet keys wrote; `forWallet` adopts those records once.
 */
export class ArkadeIntentsStore {
  private readonly swapPrefix: string
  private readonly hashPrefix: string
  private readonly fundingPrefix: string
  /** Set once this scope has adopted its unscoped records. */
  private readonly adoptedKey: string

  constructor(
    private storage: IStorageProvider,
    private readonly scope?: ArkadeIntentsStoreScope,
  ) {
    const base = scope ? scopeKey(scope) : ROOT
    this.swapPrefix = base + 'swap:'
    /** BOLT11 payment hash -> rfq_id, so `getPaymentStatus(paymentHash)` finds the swap. */
    this.hashPrefix = base + 'ln:'
    this.fundingPrefix = base + 'funding:'
    this.adoptedKey = base + 'legacy-adopted'
  }

  /**
   * Build a store on the host-injected platform storage. Throws when `setPlatform()`
   * was never called — the venue must not run without durable persistence, per its
   * persist-before-fund contract.
   */
  static fromPlatform(scope?: ArkadeIntentsStoreScope): ArkadeIntentsStore {
    const platform = getPlatform()
    if (!platform) {
      throw new ProtocolError(
        'Arkade Intents store needs platform storage; call setPlatform() first',
        'ARKADE',
        'NO_PLATFORM',
      )
    }
    return new ArkadeIntentsStore(platform.storage, scope)
  }

  /** The scope of an `@arkade-os/sdk` wallet. Throws when the wallet exposes no identity. */
  static async scopeOf(wallet: unknown, network: string): Promise<ArkadeIntentsStoreScope> {
    const identity = (wallet as { identity?: { xOnlyPublicKey?: () => Promise<Uint8Array> | Uint8Array } } | null)
      ?.identity
    const key = identity?.xOnlyPublicKey ? await identity.xOnlyPublicKey() : undefined
    if (!key?.length) {
      throw new ProtocolError('Arkade Intents needs the wallet identity to scope its swap records', 'ARKADE', 'CONFIG')
    }
    return { network, walletId: Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('') }
  }

  /** A scoped platform store with this wallet's unscoped records adopted. */
  static async forWallet(wallet: unknown, network: string): Promise<ArkadeIntentsStore> {
    const store = ArkadeIntentsStore.fromPlatform(await ArkadeIntentsStore.scopeOf(wallet, network))
    await store.adoptLegacy()
    return store
  }

  /**
   * Copy the records this wallet owns from the unscoped keys into this scope,
   * once per scope, so a swap funded before the upgrade keeps its claim/refund
   * path. Ownership is read from the record's own VHTLC key
   * (`recordBelongsTo`); a record no wallet on the host can claim stays
   * unscoped. The unscoped keys are left in place. Adopted records carry
   * `legacyAdopted`, and the engine never funds one.
   *
   * Also drops copies an earlier release adopted into this scope for another
   * wallet, while their unscoped original is still there to adopt.
   */
  async adoptLegacy(): Promise<void> {
    const scope = this.scope
    if (!scope) return
    if ((await this.storage.get(this.adoptedKey)) != null) return
    const legacy = new ArkadeIntentsStore(this.storage)
    const legacyRecords = await legacy.list()
    const owned = new Set<string>()
    for (const record of legacyRecords) {
      if (!recordBelongsTo(record, scope.walletId)) continue
      if (!(await this.get(record.id))) await this.put({ ...record, legacyAdopted: true })
      owned.add(record.id)
    }
    const foreign = new Set<string>()
    for (const record of legacyRecords) {
      if (owned.has(record.id)) continue
      const copy = await this.get(record.id)
      if (copy?.legacyAdopted && !recordBelongsTo(copy, scope.walletId)) {
        await this.storage.remove(this.swapPrefix + record.id)
        foreign.add(record.id)
      }
    }
    for (const key of await this.storage.keys()) {
      if (key.startsWith(legacy.hashPrefix)) {
        const id = await this.storage.get(key)
        if (id != null && owned.has(id)) {
          await this.storage.set(this.hashPrefix + key.slice(legacy.hashPrefix.length), id)
        }
      } else if (key.startsWith(this.hashPrefix)) {
        const id = await this.storage.get(key)
        if (id != null && foreign.has(id)) await this.storage.remove(key)
      }
    }
    await this.storage.set(this.adoptedKey, String(owned.size))
  }

  async put(record: ArkadeIntentsRecord): Promise<void> {
    await this.storage.set(this.swapPrefix + record.id, JSON.stringify(record))
  }

  async get(id: string): Promise<ArkadeIntentsRecord | undefined> {
    const raw = await this.storage.get(this.swapPrefix + id)
    if (raw == null) return undefined
    return JSON.parse(raw) as ArkadeIntentsRecord
  }

  /** Every record whose phase is `prepared` or `funded`. */
  async listPending(): Promise<ArkadeIntentsRecord[]> {
    return (await this.list()).filter((record) => PENDING_PHASES.has(record.phase))
  }

  /** Every record, any phase. */
  async list(): Promise<ArkadeIntentsRecord[]> {
    const keys = await this.storage.keys()
    const records: ArkadeIntentsRecord[] = []
    for (const key of keys) {
      if (!key.startsWith(this.swapPrefix)) continue
      const raw = await this.storage.get(key)
      if (raw == null) continue
      records.push(JSON.parse(raw) as ArkadeIntentsRecord)
    }
    return records
  }

  async linkPaymentHash(paymentHash: string, id: string): Promise<void> {
    await this.storage.set(this.hashPrefix + paymentHash.toLowerCase(), id)
  }

  async idForPaymentHash(paymentHash: string): Promise<string | undefined> {
    return (await this.storage.get(this.hashPrefix + paymentHash.toLowerCase())) ?? undefined
  }

  async setFundingMarker(id: string, marker: ArkadeIntentsFundingMarker): Promise<void> {
    await this.storage.set(this.fundingPrefix + id, JSON.stringify(marker))
  }

  /**
   * Write `marker` unless a funding marker for `id` already exists, under
   * `lock` when one is given (default: the Web Locks API). Returns the
   * existing marker when there was one, else undefined: the caller owns the
   * funding. Without a lock the check and the write are two steps, so a host
   * that funds from several contexts on one storage must provide one.
   */
  async claimFundingMarker(
    id: string,
    marker: ArkadeIntentsFundingMarker,
    lock: ArkadeIntentsFundingLock | null = webFundingLock(),
  ): Promise<ArkadeIntentsFundingMarker | undefined> {
    const claim = async () => {
      const existing = await this.getFundingMarker(id)
      if (existing) return existing
      await this.setFundingMarker(id, marker)
      return undefined
    }
    return lock ? lock(this.fundingPrefix + id, claim) : claim()
  }

  async removeFundingMarker(id: string): Promise<void> {
    await this.storage.remove(this.fundingPrefix + id)
  }

  async getFundingMarker(id: string): Promise<ArkadeIntentsFundingMarker | undefined> {
    const raw = await this.storage.get(this.fundingPrefix + id)
    return raw == null ? undefined : (JSON.parse(raw) as ArkadeIntentsFundingMarker)
  }

  /** Every funding marker, by rfq_id. */
  async listFundingMarkers(): Promise<Map<string, ArkadeIntentsFundingMarker>> {
    const out = new Map<string, ArkadeIntentsFundingMarker>()
    for (const key of await this.storage.keys()) {
      if (!key.startsWith(this.fundingPrefix)) continue
      const raw = await this.storage.get(key)
      if (raw != null) out.set(key.slice(this.fundingPrefix.length), JSON.parse(raw) as ArkadeIntentsFundingMarker)
    }
    return out
  }
}
