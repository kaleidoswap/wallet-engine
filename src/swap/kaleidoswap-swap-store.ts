import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

import { log } from '../lib/log'
import { getPlatform } from '../ports'

export type KaleidoswapSwapState =
  | 'approved'
  | 'initialized'
  | 'whitelisted'
  | 'executing'
  | 'execution_unknown'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'cancelled'
  | 'unknown'

/** Durable, SDK-neutral recovery record for one approved KaleidoSwap RFQ. */
export interface KaleidoswapSwapRecord {
  quoteId: string
  paymentHash?: string
  /** Bearer credential for maker status calls. Stored only in the host credential store. */
  accessToken?: string
  fromAsset: string
  fromAmount: number
  toAsset: string
  toAmount: number
  expiresAt: number
  createdAt: number
  updatedAt: number
  state: KaleidoswapSwapState
}

const STORAGE_PREFIX = 'wallet-engine:kaleidoswap:v1:'
const memoryStore = new Map<string, string>()
const inFlightQuotes = new Set<string>()
let warnedNoStorage = false
let warnedNoWalletIdentity = false
let anonymousSession = 0

function digest(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)))
}

export function kaleidoswapNow(): number {
  return getPlatform()?.runtime.now() ?? Date.now()
}

/** Missing wallet identity disables persistence to prevent cross-wallet records. */
export class KaleidoswapSwapStore {
  private readonly prefix: string
  private readonly persistent: boolean

  constructor(walletIdentity?: string) {
    const identity = walletIdentity?.trim()
    this.persistent = !!identity
    this.prefix = `${STORAGE_PREFIX}${digest(identity || `anonymous-session-${++anonymousSession}`)}:`
    if (!identity && !warnedNoWalletIdentity) {
      warnedNoWalletIdentity = true
      log.warn('[KaleidoswapSwapStore] No wallet identity; swap recovery is session-memory only')
    }
  }

  private key(quoteId: string): string {
    return `${this.prefix}${digest(quoteId)}`
  }

  /** Synchronous process-wide claim; call before the first async storage read. */
  tryClaim(quoteId: string): boolean {
    const key = this.key(quoteId)
    if (inFlightQuotes.has(key)) return false
    inFlightQuotes.add(key)
    return true
  }

  releaseClaim(quoteId: string): void {
    inFlightQuotes.delete(this.key(quoteId))
  }

  private async keys(): Promise<string[]> {
    const storage = this.persistent ? getPlatform()?.storage : undefined
    if (storage) return (await storage.keys()).filter((key) => key.startsWith(this.prefix))
    this.warnMemoryFallback()
    return [...memoryStore.keys()].filter((key) => key.startsWith(this.prefix))
  }

  private async read(key: string): Promise<KaleidoswapSwapRecord | null> {
    const storage = this.persistent ? getPlatform()?.storage : undefined
    if (!storage) this.warnMemoryFallback()
    const raw = storage ? await storage.get(key) : (memoryStore.get(key) ?? null)
    if (!raw) return null
    try {
      const record = JSON.parse(raw) as KaleidoswapSwapRecord
      return typeof record?.quoteId === 'string' ? record : null
    } catch {
      log.warn('[KaleidoswapSwapStore] Ignoring a corrupt swap recovery record')
      return null
    }
  }

  private async write(record: KaleidoswapSwapRecord): Promise<void> {
    const key = this.key(record.quoteId)
    const raw = JSON.stringify(record)
    const storage = this.persistent ? getPlatform()?.storage : undefined
    if (storage) {
      await storage.set(key, raw)
      return
    }
    this.warnMemoryFallback()
    memoryStore.set(key, raw)
  }

  private warnMemoryFallback(): void {
    if (warnedNoStorage || !this.persistent) return
    warnedNoStorage = true
    log.warn('[KaleidoswapSwapStore] No storage provider; swap recovery is session-memory only')
  }

  async save(record: KaleidoswapSwapRecord): Promise<KaleidoswapSwapRecord> {
    await this.write(record)
    return record
  }

  async getByQuoteId(quoteId: string): Promise<KaleidoswapSwapRecord | null> {
    return this.read(this.key(quoteId))
  }

  async list(): Promise<KaleidoswapSwapRecord[]> {
    const records = await Promise.all((await this.keys()).map((key) => this.read(key)))
    return records
      .filter((record): record is KaleidoswapSwapRecord => record !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async find(identifier: string): Promise<KaleidoswapSwapRecord | null> {
    const byQuote = await this.getByQuoteId(identifier)
    if (byQuote) return byQuote
    return (await this.list()).find((record) => record.paymentHash === identifier) ?? null
  }

  async update(
    identifier: string,
    patch: Partial<Omit<KaleidoswapSwapRecord, 'quoteId' | 'createdAt'>>,
  ): Promise<KaleidoswapSwapRecord | null> {
    const existing = await this.find(identifier)
    if (!existing) return null
    const updated = { ...existing, ...patch, quoteId: existing.quoteId, createdAt: existing.createdAt }
    await this.write(updated)
    return updated
  }

  async listIncomplete(): Promise<KaleidoswapSwapRecord[]> {
    return (await this.list()).filter(
      (record) => record.state !== 'confirmed' && record.state !== 'failed' && record.state !== 'cancelled',
    )
  }
}
