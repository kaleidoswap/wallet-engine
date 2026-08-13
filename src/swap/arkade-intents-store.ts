/**
 * Arkade Intents swap store
 * -------------------------
 * Persists the `@kaleidorg/swap-sdk/arkade` venue's recovery records through
 * the platform `IStorageProvider` seam, so they survive a service-worker
 * eviction or an app restart on every host (extension, RN, node) without the
 * engine owning any IndexedDB code.
 *
 * The venue's contract makes this store the safety line: a corridor record is
 * written BEFORE the lockup is funded, and a record lost after funding is a
 * VHTLC the wallet can no longer rebuild. Records are plain JSON end-to-end by
 * the venue's own guarantee (covenant options arrive pre-serialized), so a
 * bare `JSON.stringify` round-trips them exactly — no tagged bigint encoding
 * is needed here, unlike the Boltz chain-swap store.
 *
 * The canonical record/store types live in `@kaleidorg/swap-sdk/arkade`
 * (`ArkadeSwapRecord` / `ArkadeSwapStore`). The engine mirrors the structural
 * subset it relies on so this module compiles against any installed swap-sdk
 * version; TS structural typing makes the venue accept this store as-is.
 */

import { getPlatform, type IStorageProvider } from '../ports'
import { ProtocolError } from '../types/base'

/** Venue phases with live records — everything else is terminal. */
const PENDING_PHASES = new Set(['prepared', 'funded'])

/**
 * Structural subset of the venue's `ArkadeSwapRecord`. The venue writes and
 * reads whole records; the store only ever inspects `id` and `phase`.
 */
export interface ArkadeIntentsRecord {
  /** The rfq_id — the record key. */
  id: string
  /** Venue phase: prepared | funded | settled | refunded | cancelled | needs_recovery. */
  phase: string
  [key: string]: unknown
}

const KEY_PREFIX = 'arkade:intents:swap:'

/**
 * `IStorageProvider`-backed implementation of the venue's `ArkadeSwapStore`
 * port. One record per key under `arkade:intents:swap:<rfq_id>`.
 */
export class ArkadeIntentsStore {
  constructor(private storage: IStorageProvider) {}

  /**
   * Build a store on the host-injected platform storage. Throws when the host
   * never called `setPlatform()` — the venue must not run without durable
   * persistence, per its persist-before-fund contract.
   */
  static fromPlatform(): ArkadeIntentsStore {
    const platform = getPlatform()
    if (!platform) {
      throw new ProtocolError(
        'Arkade Intents store needs platform storage; call setPlatform() first',
        'ARKADE',
        'NO_PLATFORM',
      )
    }
    return new ArkadeIntentsStore(platform.storage)
  }

  async put(record: ArkadeIntentsRecord): Promise<void> {
    await this.storage.set(KEY_PREFIX + record.id, JSON.stringify(record))
  }

  async get(id: string): Promise<ArkadeIntentsRecord | undefined> {
    const raw = await this.storage.get(KEY_PREFIX + id)
    if (raw == null) return undefined
    return JSON.parse(raw) as ArkadeIntentsRecord
  }

  /** Every record whose phase is `prepared` or `funded`. */
  async listPending(): Promise<ArkadeIntentsRecord[]> {
    const keys = await this.storage.keys()
    const pending: ArkadeIntentsRecord[] = []
    for (const key of keys) {
      if (!key.startsWith(KEY_PREFIX)) continue
      const raw = await this.storage.get(key)
      if (raw == null) continue
      const record = JSON.parse(raw) as ArkadeIntentsRecord
      if (PENDING_PHASES.has(record.phase)) pending.push(record)
    }
    return pending
  }
}
