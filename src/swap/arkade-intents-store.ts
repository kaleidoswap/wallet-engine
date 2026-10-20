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
/** Set once unscoped records from before per-wallet keys were copied into a scope. */
const LEGACY_ADOPTED_KEY = ROOT + 'legacy-adopted'

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

  constructor(
    private storage: IStorageProvider,
    scope?: ArkadeIntentsStoreScope,
  ) {
    const base = scope ? scopeKey(scope) : ROOT
    this.swapPrefix = base + 'swap:'
    /** BOLT11 payment hash -> rfq_id, so `getPaymentStatus(paymentHash)` finds the swap. */
    this.hashPrefix = base + 'ln:'
    this.fundingPrefix = base + 'funding:'
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

  /** A scoped platform store with the unscoped records adopted (once per host). */
  static async forWallet(wallet: unknown, network: string): Promise<ArkadeIntentsStore> {
    const store = ArkadeIntentsStore.fromPlatform(await ArkadeIntentsStore.scopeOf(wallet, network))
    await store.adoptLegacy()
    return store
  }

  /**
   * Copy records written under the unscoped keys into this scope, once per host,
   * so a swap funded before the upgrade keeps its claim/refund path. The unscoped
   * keys are left in place. Adopted records carry `legacyAdopted`; the engine
   * never funds one, since it cannot tell which wallet quoted it.
   */
  async adoptLegacy(): Promise<void> {
    const legacy = new ArkadeIntentsStore(this.storage)
    if (this.swapPrefix === legacy.swapPrefix) return
    if ((await this.storage.get(LEGACY_ADOPTED_KEY)) != null) return
    const adopted = new Set<string>()
    for (const record of await legacy.list()) {
      if (!(await this.get(record.id))) await this.put({ ...record, legacyAdopted: true })
      adopted.add(record.id)
    }
    for (const key of await this.storage.keys()) {
      if (!key.startsWith(legacy.hashPrefix)) continue
      const id = await this.storage.get(key)
      if (id != null && adopted.has(id)) {
        await this.storage.set(this.hashPrefix + key.slice(legacy.hashPrefix.length), id)
      }
    }
    await this.storage.set(LEGACY_ADOPTED_KEY, this.swapPrefix)
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
