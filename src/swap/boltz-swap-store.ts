/**
 * Boltz chain-swap store
 * ----------------------
 * Persists every swap through the `IStorageProvider` seam so it survives a
 * service-worker eviction. Not a cache: a swap whose record is lost is funds locked
 * in a script the wallet can no longer rebuild, so records are written BEFORE the
 * lockup is funded and kept until claimed, refunded, or provably expired unfunded.
 *
 * Two things must round-trip exactly:
 *  - the swap index, seeding BIP85 key + preimage derivation. Reuse makes the maker
 *    reject the create with `swap_already_exists` (409), so indices are allocated
 *    monotonically and persisted before use.
 *  - the create response, which `SwapScript.fromChain` re-parses to rebuild the
 *    claim/refund scripts. Its 64-bit amounts arrive as `bigint`, which
 *    `JSON.stringify` throws on, so it is stored through a tagged encoding rather
 *    than coerced to `number` — a lossy round-trip is a malformed script.
 */

import { getPlatform, type IStorageProvider } from '../ports'
import { ProtocolError } from '../types/base'

/** Phase of a chain swap, as tracked locally. Maker status maps onto this. */
export type BoltzChainSwapPhase =
  /** Created at the maker; our lockup is NOT funded. Nothing at risk yet. */
  | 'created'
  /** We broadcast the user lockup. Funds are committed from here on. */
  | 'lockup_funded'
  /**
   * The maker's lockup is in the mempool but UNCONFIRMED — deliberately not
   * claimable. Claiming is a zero-conf bet: the maker can replace an RBF-signalling
   * lockup after our claim reveals the preimage, so we would give up the secret for
   * a transaction that never confirms.
   */
  | 'server_locking'
  /** The maker's lockup is confirmed — the claim is available. */
  | 'server_locked'
  /** Our claim transaction is broadcast. */
  | 'claimed'
  /** Terminal-but-owed: our lockup is funded and the swap failed/expired. */
  | 'refundable'
  /** Our refund transaction is broadcast. */
  | 'refunded'
  /** Terminal with nothing owed (expired before we funded). */
  | 'failed'

/** Chain side of a swap leg, in the maker's own symbols. */
export type BoltzChainAsset = 'BTC' | 'L-BTC'

export interface BoltzChainSwapRecord {
  swapId: string
  /** BIP85 derivation index for this swap's key + preimage. */
  index: number
  from: BoltzChainAsset
  to: BoltzChainAsset
  /** Sats we must lock, exactly, in a single output. */
  userLockAmount: number
  /** Sats the maker locks for us — the binding figure from the create response. */
  serverLockAmount: number
  /**
   * Height on the destination chain after which the maker can reclaim its lockup.
   * Claims are refused as this approaches: a late claim races the maker's refund and
   * can reveal the preimage for nothing.
   */
  claimTimeoutBlockHeight: number
  /**
   * The maker has spent our lockup, only possible with the preimage our claim
   * revealed. Once set, claims bypass the timeout guard — the secret is already out.
   */
  userLockupSpent?: boolean
  /** Address we must fund with `userLockAmount`. */
  lockupAddress: string
  lockupBip21?: string
  /** Wallet address the claim pays out to. */
  destinationAddress: string
  phase: BoltzChainSwapPhase
  /** Last raw maker status string, kept verbatim for diagnostics. */
  status?: string
  lockupTxid?: string
  claimTxid?: string
  refundTxid?: string
  createdAt: number
  updatedAt: number
  /** `createChainSwap` response, bigint-preserving (see `encode`/`decode`). */
  response: string
}

const KEY_PREFIX = 'boltz:chain:swap:'
const KEY_INDEX = 'boltz:chain:index'

/** Marker for a BigInt in the encoded form. Chosen not to collide with SDK payloads. */
const BIGINT_TAG = '__bigint__'

/**
 * `JSON.stringify` that survives the wasm boundary's `bigint` amounts by tagging
 * them, so `decode` restores the exact type. Coercing to `number` would round-trip
 * most values silently and corrupt the rest, and the output feeds script
 * reconstruction rather than a display field.
 */
export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? { [BIGINT_TAG]: v.toString() } : v
  )
}

/** Inverse of `encode`. */
export function decode(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v && typeof v === 'object' && BIGINT_TAG in (v as Record<string, unknown>)) {
      return BigInt(String((v as Record<string, unknown>)[BIGINT_TAG]))
    }
    return v
  })
}

export class BoltzChainSwapStore {
  /** Serializes index allocation so two concurrent creates cannot share an index. */
  private indexLock: Promise<unknown> = Promise.resolve()

  constructor(private storage: IStorageProvider) {}

  /** Build a store on the host-injected platform storage. */
  static fromPlatform(): BoltzChainSwapStore {
    const platform = getPlatform()
    if (!platform) {
      throw new ProtocolError(
        'Boltz chain swaps require platform storage — call setPlatform() before creating a swap',
        'BTC',
        'NO_PLATFORM'
      )
    }
    return new BoltzChainSwapStore(platform.storage)
  }

  /**
   * Reserve the next derivation index, persisted before it is handed out, so a
   * crash burns an index rather than risking a reuse the maker would reject.
   */
  async nextIndex(): Promise<number> {
    const run = this.indexLock.then(async () => {
      const raw = await this.storage.get(KEY_INDEX)
      const current = raw == null ? -1 : Number(raw)
      if (!Number.isSafeInteger(current)) {
        throw new ProtocolError(
          `Corrupt Boltz swap index in storage: ${String(raw)}`,
          'BTC',
          'BAD_INDEX'
        )
      }
      const next = current + 1
      await this.storage.set(KEY_INDEX, String(next))
      return next
    })
    // Keep the chain alive across failures so one bad read cannot wedge the lock.
    this.indexLock = run.catch(() => undefined)
    return run
  }

  async put(record: BoltzChainSwapRecord): Promise<void> {
    await this.storage.set(KEY_PREFIX + record.swapId, encode(record))
  }

  async get(swapId: string): Promise<BoltzChainSwapRecord | null> {
    const raw = await this.storage.get(KEY_PREFIX + swapId)
    if (raw == null) return null
    return decode(raw) as BoltzChainSwapRecord
  }

  async list(): Promise<BoltzChainSwapRecord[]> {
    const keys = await this.storage.keys()
    const records: BoltzChainSwapRecord[] = []
    for (const key of keys) {
      if (!key.startsWith(KEY_PREFIX)) continue
      const raw = await this.storage.get(key)
      if (raw == null) continue
      records.push(decode(raw) as BoltzChainSwapRecord)
    }
    return records.sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Drop a record. Only safe once settled — a funded swap without its record cannot
   * be claimed or refunded.
   */
  async remove(swapId: string): Promise<void> {
    await this.storage.remove(KEY_PREFIX + swapId)
  }
}
