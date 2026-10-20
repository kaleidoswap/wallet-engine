/**
 * Lightning on Arkade over Arkade Intents.
 *
 * Ark -> LN is two steps so the engine never moves funds the host did not
 * approve: `quoteSend` asks the solver and persists the swap record (nothing is
 * at stake yet), `executeSend` funds the quoted lockup. LN -> Ark asks the solver
 * for a hold invoice; paying it is the payer's act, and the claim that lands the
 * sats here runs from `reconcile`, which the adapter drives while connected and
 * the host can drive from its own scheduler (MV3 alarms).
 *
 * Records live in the platform-backed `ArkadeIntentsStore`, written by the venue
 * before any value moves, so claims and refunds resume after a restart.
 */

import { arkadeIntentsClientManager, loadArkadeIntentsModule, type ArkadeIntentsVenueLike } from './arkade-intents-client-manager'
import { decodeBolt11Invoice, type Bolt11Hrp } from './bolt11'
import { log } from './log'
import {
  ArkadeIntentsStore,
  type ArkadeIntentsFundingLock,
  type ArkadeIntentsFundingMarker,
  type ArkadeIntentsRecord,
} from '../swap/arkade-intents-store'
import { ErrorCode, ProtocolError } from '../types/base'

/** Host settings for the Intents corridor. Pass `{}` to take every default. */
export interface ArkadeIntentsConfig {
  /** Default true when the object is present. */
  enabled?: boolean
  /**
   * The maker's `/v2` base URL (as for the rest of the swap SDK); the Intents
   * corridor (`POST /v1/swap`, `GET /v1/card`) is its sibling. Defaults to the
   * KaleidoSwap signet maker on mutinynet/signet; no default on other networks.
   */
  solverUrl?: string
  /** A ready RFQ transport (e.g. Nostr). Wins over `solverUrl`. */
  transport?: unknown
  /**
   * The solver's claim-daemon (covclaimd) compressed pubkey, 66 hex. Optional:
   * without it the wallet claims receives itself while connected; with it the
   * solver's daemon can also claim while the wallet is offline.
   */
  covclaimdPubkey?: string
  /** Emulator co-signer key for the covenant suite, when the solver needs one. */
  emulatorPubkey?: string
  /** Fee ceiling as basis points of the Lightning amount. Default 300 (3%). */
  maxFeeBps?: number
  /** In-process reconcile cadence while connected. Default 30 000 ms; 0 disables. */
  reconcileIntervalMs?: number
  /** `fetch` used to read the solver card's limits. Defaults to the global one. */
  fetch?: typeof fetch
}

/** Default maker `/v2` bases by Arkade network (the extension's signet solver). */
export const DEFAULT_INTENTS_SOLVER_URLS: Readonly<Record<string, string>> = {
  mutinynet: 'https://maker.signet.kaleidoswap.com/v2',
  signet: 'https://maker.signet.kaleidoswap.com/v2',
}

/** The corridor root for a maker `/v2` base (same rule as the swap SDK). */
function corridorRoot(makerUrl: string): string {
  const url = new URL(makerUrl)
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v2$/, '')
  return url.toString().replace(/\/+$/, '')
}

const DEFAULT_MAX_FEE_BPS = 300
const DEFAULT_RECONCILE_MS = 30_000
const CARD_TTL_SECONDS = 300
const SEND_ROUTE = 'arkade:BTC->lightning:BTC'

/**
 * A quote must still have this long to run when its lockup is funded, so the
 * funding lands (and the solver sees it) before `valid_until`.
 */
export const FUNDING_MARGIN_SECONDS = 30

/**
 * How long a lockup may stay invisible to the indexer past `valid_until`
 * before it counts as never funded. Mirrors `DEFAULT_UNKNOWN_LOCKUP_GRACE_SECONDS`
 * in `@kaleidorg/swap-sdk/arkade` (15 min).
 */
export const UNKNOWN_LOCKUP_GRACE_SECONDS = 15 * 60

/** Venue phases a send never leaves: its funding marker has nothing left to guard. */
const TERMINAL_PHASES = new Set(['settled', 'refunded', 'failed'])

/** Sends being funded in this process, by rfq_id: a second call joins the first. */
const sendsInFlight = new Map<string, Promise<ArkadeLightningSwap>>()

/** Host-facing swap status. `pending` until the solver settles, never `confirmed` on funding. */
export type ArkadeLightningSwapStatus =
  | 'quoted'
  | 'pending'
  | 'settled'
  | 'refunded'
  | 'cancelled'
  | 'failed'
  | 'needs_recovery'

export interface ArkadeLightningSwap {
  id: string
  direction: 'send' | 'receive'
  status: ArkadeLightningSwapStatus
  /** The venue's raw phase. */
  phase: string
  paymentHash?: string
  invoice?: string
  /** Sats moved on the Arkade side (locked on a send, received on a receive). */
  arkadeAmountSats: number
  /** Sats on the Lightning side (invoice amount). */
  lightningAmountSats: number
  feeSats: number
  createdAt: number
  validUntil?: number
  refundLocktime?: number
  fundingTxid?: string
  resolvedTxid?: string
  failureReason?: string
  /** Sends: earliest unix second a refund without the solver can be pushed. */
  refundAvailableAt?: number
  /** Set when `status === 'needs_recovery'`: what the host must do next. */
  recoveryHint?: string
}

/**
 * How long past `refund_locktime` the Ark server can still reject the refund
 * push: the CLTV matures against median-time-past, which trails wall clock.
 * Mirrors `REFUND_MTP_LAG_SECONDS` in `@arkade-os/swap` (2 h).
 */
export const REFUND_MTP_LAG_SECONDS = 2 * 3600

const RECOVERY_HINT =
  "The lockup's batch was swept, so no offchain refund can move it. Run the wallet's VTXO recovery " +
  '(or a unilateral exit of the listed outpoints) and call refundLightningSend again.'

export interface ArkadeLightningSendQuote {
  /** The rfq_id; pass to `executeSend`. */
  id: string
  invoice: string
  paymentHash: string
  invoiceAmountSats: number
  /** What `executeSend` locks from the wallet. */
  fundAmountSats: number
  /**
   * The solver's whole charge (spread). Intents quotes carry no separate
   * Lightning routing fee: the solver pays routing out of this.
   */
  feeSats: number
  /** The ceiling this quote was checked against. */
  maxFeeSats: number
  /** Fund before this, unix seconds. */
  validUntil: number
  /** After this, unix seconds, an unclaimed lockup can be refunded. */
  refundLocktime?: number
  /** Invoice expiry, unix seconds. */
  invoiceExpiresAt: number
  solverPubkey?: string
}

export interface ArkadeLightningReceive {
  id: string
  invoice: string
  paymentHash: string
  /** What the payer pays. */
  payAmountSats: number
  /** What lands on Arkade once claimed. */
  expectedAmountSats: number
  feeSats: number
  /** Unix seconds. */
  invoiceExpiresAt: number
}

export type ArkadeIntentsRefusalKind =
  | 'below_minimum'
  | 'above_maximum'
  | 'no_capacity'
  | 'out_of_range'
  /** `quote_conflict`: the solver already holds a swap for this payment hash
   * (it keeps one per hash once quoted, and cannot pay its own invoice). */
  | 'already_quoted'
  | 'other'

/**
 * The solver declined to quote. `reason` is the solver's own code
 * (`amount_out_of_range`, `exposure_cap`, …); `limit`/`actual` are set when the
 * solver or its published card states them.
 */
export class ArkadeIntentsRefusalError extends ProtocolError {
  readonly reason: string
  readonly kind: ArkadeIntentsRefusalKind
  readonly errorCode?: string
  readonly actual?: number
  readonly limit?: number
  readonly expected?: number
  readonly unit?: string
  constructor(
    message: string,
    fields: {
      reason: string
      kind: ArkadeIntentsRefusalKind
      errorCode?: string
      actual?: number
      limit?: number
      expected?: number
      unit?: string
    },
    cause?: unknown,
  ) {
    super(message, 'ARKADE', 'INTENTS_REFUSED', cause)
    this.name = 'ArkadeIntentsRefusalError'
    this.reason = fields.reason
    this.kind = fields.kind
    this.errorCode = fields.errorCode
    this.actual = fields.actual
    this.limit = fields.limit
    this.expected = fields.expected
    this.unit = fields.unit
  }
}

interface CardLimits {
  /** Lightning-side bounds, sats. */
  minLightningSats?: number
  maxLightningSats?: number
  feeBps?: number
}

/** BOLT11 prefixes valid for an Arkade server network; null for an empty or unknown one. */
export function lightningHrpsForArkadeNetwork(network: string): readonly Bolt11Hrp[] | null {
  switch (network) {
    case 'bitcoin':
    case 'mainnet':
      return ['bc']
    case 'mutinynet':
      return ['tbs']
    case 'signet':
      return ['tbs', 'tb']
    case 'testnet':
      return ['tb']
    case 'regtest':
      return ['bcrt']
    default:
      return null
  }
}

const num = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined
}

function statusOf(phase: string): ArkadeLightningSwapStatus {
  switch (phase) {
    case 'prepared':
      return 'quoted'
    case 'funded':
      return 'pending'
    case 'settled':
    case 'refunded':
    case 'cancelled':
    case 'failed':
    case 'needs_recovery':
      return phase
    default:
      return 'pending'
  }
}

export interface ArkadeIntentsLightningDeps {
  config: ArkadeIntentsConfig
  /** The connected `@arkade-os/sdk` wallet (binds the venue). */
  getWallet: () => any
  /** Send `amount` sats to an Ark address with the adapter's own coin selection; resolves the txid. */
  fund: (address: string, amount: number) => Promise<string>
  /** The Ark server's network name (`getInfo().network`). */
  getNetwork: () => Promise<string>
  arkServerUrl: string
  /** Unix seconds. */
  now?: () => number
  /** Override the platform-backed store (tests). */
  store?: ArkadeIntentsStore
  /**
   * Cross-context lock for claiming a quote before funding it. Defaults to the
   * Web Locks API; without either, only calls in this process are serialized.
   */
  fundingLock?: ArkadeIntentsFundingLock
  /**
   * Whether anything ever landed at a lockup script (hex). Defaults to the
   * wallet's indexer, the same read the venue uses.
   */
  lockupFunded?: (swapPkScriptHex: string) => Promise<boolean>
}

export class ArkadeIntentsLightning {
  private timer: ReturnType<typeof setInterval> | null = null
  private card: { limits: CardLimits; at: number } | null = null
  private initPromise: Promise<ArkadeIntentsVenueLike | null> | null = null
  private resumed = false
  private ownStore: Promise<ArkadeIntentsStore> | null = null

  constructor(private readonly deps: ArkadeIntentsLightningDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000)
  }

  /**
   * The live venue's store when it is ours to read, else one scoped to this
   * wallet and Ark network (the same keys a default venue store uses).
   */
  private async store(): Promise<ArkadeIntentsStore> {
    if (this.deps.store) return this.deps.store
    const live = arkadeIntentsClientManager.getStore()
    if (live instanceof ArkadeIntentsStore) return live
    this.ownStore ??= (async () => ArkadeIntentsStore.forWallet(this.deps.getWallet(), await this.deps.getNetwork()))()
    try {
      return await this.ownStore
    } catch (error) {
      this.ownStore = null
      throw error
    }
  }

  get enabled(): boolean {
    return this.deps.config.enabled !== false
  }

  /** True once a venue is live (ours, or one the host initialized). */
  isAvailable(): boolean {
    return this.enabled && arkadeIntentsClientManager.isInitialized()
  }

  private async solverUrl(): Promise<string | undefined> {
    if (this.deps.config.solverUrl) return this.deps.config.solverUrl
    return DEFAULT_INTENTS_SOLVER_URLS[await this.deps.getNetwork()]
  }

  /** Initialize the venue from config unless the host already has one. Never throws. */
  async start(): Promise<boolean> {
    if (!this.enabled) return false
    this.initPromise ??= this.initVenue().catch((error: unknown) => {
      log.warn('[ArkadeIntents] Venue init failed; Lightning on Arkade unavailable:', error)
      this.initPromise = null
      return null
    })
    const venue = await this.initPromise
    if (venue && !this.timer && !this.resumed) {
      // Resume whatever a previous session left pending (claims, refunds now
      // due). Also for a venue the host initialized: before, only a venue this
      // class built got the immediate pass, so a host-built one waited a full
      // interval before resuming.
      this.resumed = true
      void this.reconcile().catch((error: unknown) => log.warn('[ArkadeIntents] Resume reconcile failed:', error))
    }
    if (venue) this.startReconcileLoop()
    return venue !== null
  }

  private async initVenue(): Promise<ArkadeIntentsVenueLike | null> {
    if (arkadeIntentsClientManager.isInitialized()) return arkadeIntentsClientManager.getVenue()
    let transport = this.deps.config.transport
    if (!transport) {
      const url = await this.solverUrl()
      if (!url) {
        log.info('[ArkadeIntents] No solver for this network; Lightning on Arkade unavailable')
        return null
      }
      const mod = await loadArkadeIntentsModule()
      transport = mod.kaleidoswapHttpTransport(url)
    }
    await arkadeIntentsClientManager.initialize(this.deps.getWallet(), {
      arkServerUrl: this.deps.arkServerUrl,
      transport,
      store: await this.store(),
    })
    return arkadeIntentsClientManager.getVenue()
  }

  private startReconcileLoop(): void {
    const ms = this.deps.config.reconcileIntervalMs ?? DEFAULT_RECONCILE_MS
    if (this.timer || ms <= 0) return
    this.timer = setInterval(() => {
      void this.reconcile().catch((error: unknown) => log.warn('[ArkadeIntents] Reconcile failed:', error))
    }, ms)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.initPromise = null
    this.resumed = false
    this.card = null
    this.ownStore = null
  }

  private async venue(): Promise<ArkadeIntentsVenueLike> {
    if (!this.enabled) {
      throw new ProtocolError('Arkade Intents is disabled', 'ARKADE', ErrorCode.NOT_CONFIGURED)
    }
    if (!arkadeIntentsClientManager.isInitialized()) await this.start()
    if (!arkadeIntentsClientManager.isInitialized()) {
      throw new ProtocolError(
        'Lightning on Arkade needs Arkade Intents: configure a solver (ArkadeConfig.intents)',
        'ARKADE',
        ErrorCode.NOT_CONFIGURED,
      )
    }
    return arkadeIntentsClientManager.getVenue()
  }

  /** Decode a bolt11 and require an amount, a live expiry and this Ark network's HRP. */
  async checkInvoice(invoice: string): Promise<{ raw: string; paymentHash: string; amountSats: number; expiresAt: number }> {
    const raw = invoice.trim().replace(/^lightning:/i, '')
    let decoded
    try {
      decoded = decodeBolt11Invoice(raw)
    } catch (error) {
      throw new ProtocolError('Invalid Lightning invoice', 'ARKADE', 'INVALID_INVOICE', error)
    }
    const network = await this.deps.getNetwork()
    const hrps = lightningHrpsForArkadeNetwork(network)
    if (!hrps) {
      throw new ProtocolError(
        `Cannot check the invoice network: unknown Arkade network '${network}'`,
        'ARKADE',
        'INVOICE_NETWORK_MISMATCH',
      )
    }
    if (!hrps.includes(decoded.network.hrp)) {
      throw new ProtocolError(
        `Invoice is for ln${decoded.network.hrp}, but this Arkade wallet is on ${network} (expects ${hrps.map((h) => 'ln' + h).join(' or ')})`,
        'ARKADE',
        'INVOICE_NETWORK_MISMATCH',
      )
    }
    const amountSats = num(decoded.amountSat)
    if (!amountSats) {
      throw new ProtocolError('Arkade Intents cannot pay an amountless invoice', 'ARKADE', 'INVALID_AMOUNT')
    }
    if (decoded.expiresAtUnixSeconds <= this.now()) {
      throw new ProtocolError('Lightning invoice has expired', 'ARKADE', 'INVOICE_EXPIRED')
    }
    return { raw, paymentHash: decoded.paymentHash, amountSats, expiresAt: decoded.expiresAtUnixSeconds }
  }

  private feeCeiling(amountSats: number, maxFeeSats?: number): number {
    if (maxFeeSats != null) return maxFeeSats
    const bps = this.deps.config.maxFeeBps ?? DEFAULT_MAX_FEE_BPS
    return Math.ceil((amountSats * bps) / 10_000)
  }

  /** The solver card's published Lightning limits (HTTP solvers only), cached. */
  private async cardLimits(): Promise<CardLimits | null> {
    if (this.card && this.now() - this.card.at < CARD_TTL_SECONDS) return this.card.limits
    if (this.deps.config.transport) return null
    const url = await this.solverUrl()
    const fetchImpl = this.deps.config.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch
    if (!url || !fetchImpl) return null
    try {
      const res = await fetchImpl(`${corridorRoot(url)}/v1/card`)
      if (!res.ok) return null
      const card = (await res.json()) as { markets?: Array<Record<string, unknown>> }
      const market = card.markets?.find((m) => m.quote_corridor === 'lightning')
      if (!market) return null
      const limits: CardLimits = {
        minLightningSats: num(market.min_quote_amount),
        maxLightningSats: num(market.max_quote_amount),
        feeBps: num(market.fee_bps),
      }
      this.card = { limits, at: this.now() }
      return limits
    } catch {
      return null
    }
  }

  private async checkCardLimits(amountSats: number): Promise<void> {
    const limits = await this.cardLimits()
    if (!limits) return
    const { minLightningSats: min, maxLightningSats: max } = limits
    if (min != null && amountSats < min) {
      throw new ArkadeIntentsRefusalError(`Amount ${amountSats} sats is below the solver minimum of ${min} sats`, {
        reason: 'amount_out_of_range',
        kind: 'below_minimum',
        actual: amountSats,
        limit: min,
        unit: 'sats',
      })
    }
    if (max != null && amountSats > max) {
      throw new ArkadeIntentsRefusalError(`Amount ${amountSats} sats is above the solver maximum of ${max} sats`, {
        reason: 'amount_out_of_range',
        kind: max === 0 ? 'no_capacity' : 'above_maximum',
        actual: amountSats,
        limit: max,
        unit: 'sats',
      })
    }
  }

  /** Map a venue/transport error to a typed refusal when the solver declined. */
  private async translate(error: unknown, amountSats: number): Promise<unknown> {
    const e = error as Record<string, unknown> | null
    const message = error instanceof Error ? error.message : String(error)
    const match = /solver refused: ([a-z_]+)/.exec(message)
    const reason = typeof e?.reason === 'string' ? e.reason : match?.[1]
    if (!reason) return error
    const actual = num(e?.actual) ?? amountSats
    let limit = num(e?.limit)
    let kind: ArkadeIntentsRefusalKind = 'other'
    if (reason === 'exposure_cap') kind = 'no_capacity'
    else if (reason === 'quote_conflict') {
      return new ArkadeIntentsRefusalError(
        'The solver already has a swap for this invoice (it keeps one per payment hash once quoted, ' +
          'and cannot pay an invoice it issued itself). Ask the payee for a new invoice.',
        { reason, kind: 'already_quoted', actual },
        error,
      )
    } else if (reason === 'amount_out_of_range') {
      kind = 'out_of_range'
      const card = limit == null ? await this.cardLimits() : null
      if (limit != null) kind = actual < limit ? 'below_minimum' : 'above_maximum'
      else if (card?.maxLightningSats === 0) kind = 'no_capacity'
      else if (card?.minLightningSats != null && actual < card.minLightningSats) {
        kind = 'below_minimum'
        limit = card.minLightningSats
      } else if (card?.maxLightningSats != null && actual > card.maxLightningSats) {
        kind = 'above_maximum'
        limit = card.maxLightningSats
      }
    }
    return new ArkadeIntentsRefusalError(
      `Arkade Intents solver refused: ${reason}`,
      {
        reason,
        kind,
        errorCode: typeof e?.errorCode === 'string' ? e.errorCode : undefined,
        actual,
        limit,
        expected: num(e?.expected),
        unit: typeof e?.unit === 'string' ? e.unit : limit != null ? 'sats' : undefined,
      },
      error,
    )
  }

  /** Step 1 of Ark -> LN: quote and persist. Moves nothing. */
  async quoteSend(invoice: string, opts: { maxFeeSats?: number } = {}): Promise<ArkadeLightningSendQuote> {
    const facts = await this.checkInvoice(invoice)
    const venue = await this.venue()
    const existing = await this.existingSwapFor(facts, opts)
    if (existing) return existing
    await this.checkCardLimits(facts.amountSats)
    let prepared: Record<string, any>
    try {
      prepared = await venue.prepareLightningSend({
        invoice: facts,
        ...(this.deps.config.emulatorPubkey ? { emulatorPubkey: this.deps.config.emulatorPubkey } : {}),
      })
    } catch (error) {
      throw await this.translate(error, facts.amountSats)
    }
    const summary = prepared.summary ?? {}
    const fundAmountSats = Number(prepared.fundAmountSats)
    const toAmount = Number(summary.toAmountSats ?? facts.amountSats)
    if (toAmount !== facts.amountSats || !(fundAmountSats >= toAmount)) {
      throw new ProtocolError('Solver quote does not match the invoice amount', 'ARKADE', 'INVALID_QUOTE')
    }
    const id = String(prepared.record?.id ?? summary.rfqId)
    const store = await this.store()
    await store.linkPaymentHash(facts.paymentHash, id)
    const feeSats = fundAmountSats - toAmount
    const maxFeeSats = this.feeCeiling(facts.amountSats, opts.maxFeeSats)
    const quote: ArkadeLightningSendQuote = {
      id,
      invoice: facts.raw,
      paymentHash: facts.paymentHash,
      invoiceAmountSats: facts.amountSats,
      fundAmountSats,
      feeSats,
      maxFeeSats,
      validUntil: Number(summary.validUntil),
      refundLocktime: summary.refundLocktime,
      invoiceExpiresAt: facts.expiresAt,
      solverPubkey: summary.solverPubkey,
    }
    if (feeSats > maxFeeSats) {
      throw new ProtocolError(
        `Solver fee ${feeSats} sats exceeds the ceiling of ${maxFeeSats} sats`,
        'ARKADE',
        'FEE_TOO_HIGH',
        quote,
      )
    }
    await this.rememberCeiling(store, id, maxFeeSats)
    return quote
  }

  /** The fee ceiling the caller approved at quote time, for `executeSend` to re-check. */
  private async rememberCeiling(store: ArkadeIntentsStore, id: string, maxFeeSats: number): Promise<void> {
    const record = await store.get(id)
    if (record && record.phase === 'prepared') await store.put({ ...record, engineMaxFeeSats: maxFeeSats })
  }

  /**
   * A payment hash this wallet already has a swap for. The solver keeps one
   * swap per hash once quoted, so asking again only earns `quote_conflict`;
   * worse, a hash that is already funded must never be paid a second time.
   * A still-valid quote is handed back as is (re-quoting is idempotent).
   */
  private async existingSwapFor(
    facts: { raw: string; paymentHash: string; amountSats: number; expiresAt: number },
    opts: { maxFeeSats?: number },
  ): Promise<ArkadeLightningSendQuote | null> {
    const store = await this.store()
    const id = await store.idForPaymentHash(facts.paymentHash)
    const record = id ? await store.get(id) : undefined
    if (!record) return null
    if (record.route !== SEND_ROUTE) {
      throw new ProtocolError(
        'This invoice was issued for one of this wallet\'s own Lightning receives; a wallet cannot pay itself through the solver',
        'ARKADE',
        'SELF_PAYMENT',
      )
    }
    if (!TERMINAL_PHASES.has(record.phase) && (await store.getFundingMarker(record.id))) {
      throw new ProtocolError(
        `A payment of this invoice is already in progress (swap ${record.id}); it was not paid twice`,
        'ARKADE',
        'INVOICE_IN_PROGRESS',
      )
    }
    const q = (record.quote ?? {}) as Record<string, unknown>
    const validUntil = num(q.valid_until)
    if (
      record.phase === 'prepared' &&
      !record.legacyAdopted &&
      validUntil != null &&
      validUntil > this.now() + FUNDING_MARGIN_SECONDS
    ) {
      const fundAmountSats = num(record.fundAmountSats) ?? 0
      const toAmount = num(q.to_amount) ?? facts.amountSats
      const quote: ArkadeLightningSendQuote = {
        id: record.id,
        invoice: facts.raw,
        paymentHash: facts.paymentHash,
        invoiceAmountSats: facts.amountSats,
        fundAmountSats,
        feeSats: fundAmountSats - toAmount,
        maxFeeSats: this.feeCeiling(facts.amountSats, opts.maxFeeSats),
        validUntil,
        refundLocktime: num(q.refund_locktime),
        invoiceExpiresAt: facts.expiresAt,
      }
      if (quote.feeSats > quote.maxFeeSats) {
        throw new ProtocolError(
          `Solver fee ${quote.feeSats} sats exceeds the ceiling of ${quote.maxFeeSats} sats`,
          'ARKADE',
          'FEE_TOO_HIGH',
          quote,
        )
      }
      await this.rememberCeiling(store, record.id, quote.maxFeeSats)
      return quote
    }
    switch (record.phase) {
      case 'settled':
        throw new ProtocolError('This invoice was already paid from this wallet', 'ARKADE', 'INVOICE_ALREADY_PAID')
      case 'funded':
      case 'needs_recovery':
        throw new ProtocolError(
          `A payment of this invoice is already in progress (swap ${record.id}); it was not paid twice`,
          'ARKADE',
          'INVOICE_IN_PROGRESS',
        )
      default:
        throw new ArkadeIntentsRefusalError(
          `This invoice was already quoted (swap ${record.id}, ${record.phase}) and the solver keeps one swap per payment hash. Ask the payee for a new invoice.`,
          { reason: 'quote_conflict', kind: 'already_quoted', actual: facts.amountSats },
        )
    }
  }

  /**
   * Step 2 of Ark -> LN: fund the quoted lockup. Call only after the user
   * approved the quote. Returns `pending`; the solver pays the invoice and
   * `reconcile` moves the swap to settled / refunded / failed.
   *
   * Funds at most once per quote: a concurrent call joins the one in flight,
   * and a funding marker is claimed before any value moves, so a retry, a
   * second tab or a restart never funds the same lockup twice. Across contexts
   * sharing one storage (an extension popup and its service worker) the claim
   * is atomic only under `fundingLock` or the Web Locks API; a host with
   * neither must fund from a single context. The fee is
   * re-checked against `fundAmountSats` (`maxFeeSats`, else the ceiling
   * approved at quote time, else `intents.maxFeeBps`).
   */
  executeSend(id: string, opts: { maxFeeSats?: number } = {}): Promise<ArkadeLightningSwap> {
    const running = sendsInFlight.get(id)
    if (running) return running
    const attempt = this.fundSend(id, opts).finally(() => sendsInFlight.delete(id))
    sendsInFlight.set(id, attempt)
    return attempt
  }

  private async fundSend(id: string, opts: { maxFeeSats?: number }): Promise<ArkadeLightningSwap> {
    const venue = await this.venue()
    const store = await this.store()
    const record = await store.get(id)
    if (!record || record.route !== SEND_ROUTE) {
      throw new ProtocolError(`No Arkade Intents send quote ${id}`, 'ARKADE', 'QUOTE_NOT_FOUND')
    }
    const marker = await store.getFundingMarker(id)
    if (marker) return this.alreadyClaimed(venue, store, record, marker)
    if (record.phase !== 'prepared') {
      throw new ProtocolError(`Arkade Intents swap ${id} is already ${record.phase}; it is not funded again`, 'ARKADE', 'QUOTE_USED')
    }
    if (record.legacyAdopted) {
      throw new ProtocolError('This quote predates per-wallet swap records; request a new one', 'ARKADE', 'QUOTE_EXPIRED')
    }
    const quote = (record.quote ?? {}) as Record<string, unknown>
    const validUntil = num(quote.valid_until)
    if (validUntil == null || validUntil <= this.now() + FUNDING_MARGIN_SECONDS) {
      throw new ProtocolError(
        `The quote expires too soon to fund safely (needs ${FUNDING_MARGIN_SECONDS} s left); request a new one`,
        'ARKADE',
        'QUOTE_EXPIRED',
      )
    }
    const address = record.address as string
    const amount = num(record.fundAmountSats)
    const toAmount = num(quote.to_amount)
    if (!address || !amount || !toAmount || amount < toAmount) {
      throw new ProtocolError(`Arkade Intents record ${id} has no valid funding instruction`, 'ARKADE', 'INVALID_QUOTE')
    }
    const feeSats = amount - toAmount
    const maxFeeSats = this.feeCeiling(toAmount, opts.maxFeeSats ?? num(record.engineMaxFeeSats))
    if (feeSats > maxFeeSats) {
      throw new ProtocolError(
        `Solver fee ${feeSats} sats (funding ${amount} for ${toAmount}) exceeds the ceiling of ${maxFeeSats} sats`,
        'ARKADE',
        'FEE_TOO_HIGH',
      )
    }
    const startedAt = this.now()
    // Persisted before anything moves: from here on this quote counts as funded.
    const claimed = await store.claimFundingMarker(id, { startedAt }, this.deps.fundingLock)
    if (claimed) return this.alreadyClaimed(venue, store, record, claimed)
    let fundingTxid: string
    try {
      fundingTxid = await this.deps.fund(address, amount)
    } catch (error) {
      await this.markFundingError(store, id, { startedAt, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    if (!fundingTxid) {
      await this.markFundingError(store, id, { startedAt, error: 'no txid returned' })
      throw new ProtocolError('Arkade send did not return a transaction ID', 'ARKADE', 'SEND_ERROR')
    }
    try {
      await store.setFundingMarker(id, { startedAt, fundingTxid })
    } catch (error) {
      log.error(`[ArkadeIntents] Could not persist funding txid ${fundingTxid} for ${id}:`, error)
    }
    return this.handOff(venue, store, record, fundingTxid)
  }

  /** `executeSend` on a quote that already has a funding marker. */
  private async alreadyClaimed(
    venue: ArkadeIntentsVenueLike,
    store: ArkadeIntentsStore,
    record: ArkadeIntentsRecord,
    marker: ArkadeIntentsFundingMarker,
  ): Promise<ArkadeLightningSwap> {
    if (marker.fundingTxid && record.phase === 'prepared') {
      // Funded earlier, but the hand-off to the venue was lost: finish it.
      return this.handOff(venue, store, record, marker.fundingTxid)
    }
    const state = record.phase === 'prepared' ? 'already being funded, or its funding failed midway' : `already ${record.phase}`
    throw new ProtocolError(`Arkade Intents swap ${record.id} is ${state}; it is not funded again`, 'ARKADE', 'QUOTE_USED')
  }

  private async markFundingError(store: ArkadeIntentsStore, id: string, marker: ArkadeIntentsFundingMarker): Promise<void> {
    try {
      await store.setFundingMarker(id, marker)
    } catch (error) {
      log.error(`[ArkadeIntents] Could not persist the funding error for ${id}:`, error)
    }
  }

  /**
   * Hand a funded send to the venue. When `notifyFunded` fails, the record is
   * still moved to `funded` with its txid, so the venue's reconcile tracks it
   * (claims, refunds) and never cancels it as unfunded.
   */
  private async handOff(
    venue: ArkadeIntentsVenueLike,
    store: ArkadeIntentsStore,
    record: ArkadeIntentsRecord,
    fundingTxid: string,
  ): Promise<ArkadeLightningSwap> {
    try {
      return this.toSwap(await venue.notifyFunded(record.id, fundingTxid))
    } catch (error) {
      log.warn(`[ArkadeIntents] notifyFunded failed for ${record.id} after funding ${fundingTxid}:`, error)
    }
    const current = (await store.get(record.id).catch(() => undefined)) ?? record
    const healed = { ...current, fundingTxid }
    if (current.phase === 'prepared' || current.phase === 'cancelled') healed.phase = 'funded'
    try {
      await store.put(healed)
    } catch (error) {
      log.error(`[ArkadeIntents] Could not mark ${record.id} funded (txid ${fundingTxid}):`, error)
    }
    return { ...this.toSwap(healed), status: 'pending', fundingTxid }
  }

  /**
   * LN -> Ark: a hold invoice from the solver. The claim runs from `reconcile`.
   * `amountSide: 'to'` (default) fixes the sats credited on Arkade and lets the
   * invoice carry the fee on top; `'from'` fixes the invoice amount itself.
   */
  async createReceive(
    amountSats: number,
    opts: { maxFeeSats?: number; amountSide?: 'from' | 'to' } = {},
  ): Promise<ArkadeLightningReceive> {
    const amountSide = opts.amountSide ?? 'to'
    if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
      throw new ProtocolError('Amount is required for a Lightning invoice into Arkade', 'ARKADE', 'INVALID_AMOUNT')
    }
    const venue = await this.venue()
    const covclaimd = this.deps.config.covclaimdPubkey
    if (covclaimd != null && !/^0[23][0-9a-f]{64}$/i.test(covclaimd)) {
      throw new ProtocolError('intents.covclaimdPubkey must be a 66-hex compressed pubkey', 'ARKADE', 'CONFIG')
    }
    // The venue's decoder is synchronous; the network is checked on its result.
    let solverInvoice: string | undefined
    let prepared: Record<string, any>
    try {
      prepared = await venue.prepareLightningReceive({
        amountSats,
        amountSide,
        maxPayAmountSats: amountSide === 'from' ? amountSats : amountSats + this.feeCeiling(amountSats, opts.maxFeeSats),
        ...(covclaimd ? { covclaimdPubkey: hexToBytes(covclaimd) } : {}),
        ...(this.deps.config.emulatorPubkey ? { emulatorPubkey: this.deps.config.emulatorPubkey } : {}),
        decodeInvoice: (bolt11: string) => {
          solverInvoice = bolt11
          const d = decodeBolt11Invoice(bolt11)
          return {
            raw: bolt11,
            paymentHash: d.paymentHash,
            amountSats: num(d.amountSat) ?? 0,
            expiresAt: d.expiresAtUnixSeconds,
          }
        },
      })
    } catch (error) {
      throw await this.translate(error, amountSats)
    }
    const invoice = String(prepared.invoice ?? solverInvoice)
    const facts = await this.checkInvoice(invoice)
    if (amountSide === 'from' && facts.amountSats !== amountSats) {
      throw new ProtocolError(
        `Solver invoice is for ${facts.amountSats} sats, not the requested ${amountSats}`,
        'ARKADE',
        'INVALID_QUOTE',
      )
    }
    const credited = num(prepared.summary?.toAmountSats) ?? (amountSide === 'to' ? amountSats : undefined)
    if (credited == null || credited > facts.amountSats) {
      throw new ProtocolError('Solver quote does not state what lands on Arkade', 'ARKADE', 'INVALID_QUOTE')
    }
    const ceiling = this.feeCeiling(amountSide === 'from' ? facts.amountSats : amountSats, opts.maxFeeSats)
    if (facts.amountSats - credited > ceiling) {
      throw new ProtocolError(
        `Solver fee ${facts.amountSats - credited} sats exceeds the ceiling of ${ceiling} sats`,
        'ARKADE',
        'FEE_TOO_HIGH',
      )
    }
    const id = String(prepared.record?.id)
    await (await this.store()).linkPaymentHash(facts.paymentHash, id)
    // Arm the watcher now: the payer is external, so there is no "dispatched"
    // moment to wait for, and an unpaid invoice simply ends `cancelled`.
    await venue.notifyFunded(id)
    const payAmountSats = Number(prepared.payAmountSats)
    const expectedAmountSats = Number(prepared.summary?.toAmountSats ?? (amountSide === 'to' ? amountSats : NaN))
    return {
      id,
      invoice,
      paymentHash: facts.paymentHash,
      payAmountSats,
      expectedAmountSats,
      feeSats: Number.isFinite(expectedAmountSats) ? Math.max(0, payAmountSats - expectedAmountSats) : 0,
      invoiceExpiresAt: Number(prepared.invoiceExpiresAt ?? facts.expiresAt),
    }
  }

  /** One pass over pending swaps: claims receives, settles/refunds sends. */
  async reconcile(): Promise<ArkadeLightningReconcileReport | null> {
    if (!arkadeIntentsClientManager.isInitialized()) return null
    await this.healFundingMarkers().catch((error: unknown) => log.warn('[ArkadeIntents] Funding marker pass failed:', error))
    const report = await arkadeIntentsClientManager.getVenue().reconcile()
    return { ...report, failed: report.failed ?? [] }
  }

  /**
   * One pass over this engine's funding markers:
   * - a send whose venue record reached a terminal phase drops its marker;
   * - a marked send whose record still reads `prepared` or `cancelled` (the
   *   hand-off was lost, or the venue gave up on a lagging indexer) moves to
   *   `funded` with its txid, so the venue tracks it;
   * - a marker without a txid (the funding call threw) is settled against the
   *   lockup itself: anything there moves the record to `funded`, so it can be
   *   refunded; still empty `UNKNOWN_LOCKUP_GRACE_SECONDS` past `valid_until`,
   *   the record ends `cancelled` and the marker is dropped, freeing the
   *   invoice.
   */
  private async healFundingMarkers(): Promise<void> {
    const store = await this.store()
    for (const [id, marker] of await store.listFundingMarkers()) {
      if (sendsInFlight.has(id)) continue
      try {
        const record = await store.get(id)
        if (!record) continue
        if (TERMINAL_PHASES.has(record.phase)) {
          await store.removeFundingMarker(id)
        } else if (record.phase === 'prepared' || record.phase === 'cancelled') {
          if (marker.fundingTxid) {
            log.warn(`[ArkadeIntents] Swap ${id} was funded (${marker.fundingTxid}) but reads ${record.phase}; tracking it as funded`)
            await store.put({ ...record, phase: 'funded', fundingTxid: marker.fundingTxid })
          } else {
            await this.settleUnconfirmedFunding(store, record, marker)
          }
        }
      } catch (error) {
        log.warn(`[ArkadeIntents] Funding marker for ${id} not settled this pass:`, error)
      }
    }
  }

  private async settleUnconfirmedFunding(
    store: ArkadeIntentsStore,
    record: ArkadeIntentsRecord,
    marker: ArkadeIntentsFundingMarker,
  ): Promise<void> {
    if (await this.lockupFunded(record)) {
      log.warn(`[ArkadeIntents] Swap ${record.id}: the funding call failed but its lockup is funded; tracking it as funded`)
      await store.put({ ...record, phase: 'funded' })
      return
    }
    const validUntil = num(((record.quote ?? {}) as Record<string, unknown>).valid_until) ?? marker.startedAt
    if (this.now() < validUntil + UNKNOWN_LOCKUP_GRACE_SECONDS) return
    log.info(`[ArkadeIntents] Swap ${record.id}: lockup still empty past its window; the funding never landed`)
    if (record.phase !== 'cancelled') await store.put({ ...record, phase: 'cancelled' })
    await store.removeFundingMarker(record.id)
  }

  private async lockupFunded(record: ArkadeIntentsRecord): Promise<boolean> {
    const script = typeof record.swapPkScriptHex === 'string' ? record.swapPkScriptHex : ''
    if (!script) throw new ProtocolError(`Arkade Intents record ${record.id} has no lockup script`, 'ARKADE', 'INVALID_QUOTE')
    if (this.deps.lockupFunded) return this.deps.lockupFunded(script)
    const indexer = (this.deps.getWallet() as { indexerProvider?: { getVtxos?: (opts: { scripts: string[] }) => Promise<{ vtxos?: unknown[] }> } } | null)
      ?.indexerProvider
    if (!indexer?.getVtxos) throw new ProtocolError('The Arkade wallet exposes no indexer to read the lockup', 'ARKADE', ErrorCode.NOT_CONFIGURED)
    const { vtxos } = await indexer.getVtxos({ scripts: [script] })
    return (vtxos ?? []).length > 0
  }

  /**
   * Take back a stalled send. The venue first checks whether the solver
   * already settled or refunded it; otherwise the trader's own
   * `refundWithoutReceiver` (trader + Ark operator co-sign) can only be
   * pushed once `refund_locktime` has passed, so before that this throws
   * `REFUND_NOT_YET` with `refundAvailableAt`. Idempotent: a refunded swap is
   * returned as is, and nothing is ever pushed twice.
   */
  async refundSend(id: string): Promise<ArkadeLightningSwap> {
    const venue = await this.venue()
    const store = await this.store()
    let before = await store.get(id)
    if (!before) throw new ProtocolError(`No Arkade Intents swap ${id}`, 'ARKADE', 'SWAP_NOT_FOUND')
    if (before.route !== SEND_ROUTE) {
      throw new ProtocolError(
        'A Lightning receive has nothing of this wallet\'s to refund: an unpaid invoice just expires',
        'ARKADE',
        'NOT_REFUNDABLE',
      )
    }
    switch (before.phase) {
      case 'refunded':
        return this.toSwap(before)
      case 'settled':
        throw new ProtocolError('The payment settled; there is nothing to refund', 'ARKADE', 'ALREADY_SETTLED')
      case 'prepared':
      case 'cancelled': {
        const marker = await store.getFundingMarker(id)
        if (!marker) {
          throw new ProtocolError('This swap was never funded; there is nothing to refund', 'ARKADE', 'NOTHING_TO_REFUND')
        }
        if (marker.fundingTxid) {
          // Funded, but the venue never learned it: track it before refunding.
          before = { ...before, phase: 'funded', fundingTxid: marker.fundingTxid }
          await store.put(before)
        }
        // Without a txid the funding call failed midway; the venue's refund
        // pass reads the lockup itself and finds whatever is there.
      }
    }
    const after = this.toSwap(await venue.refundSend(id))
    if (after.status !== 'pending') return after
    const at = after.refundAvailableAt
    if (at != null && this.now() < at) {
      const error = new ProtocolError(
        `Refund not possible yet: the solver has not returned the funds, and the refund without it unlocks at ${new Date(at * 1000).toISOString()}`,
        'ARKADE',
        'REFUND_NOT_YET',
        { refundAvailableAt: at, swap: after },
      )
      Object.assign(error, { refundAvailableAt: at })
      throw error
    }
    // Past the locktime: the push is in flight, or the Ark server still waits
    // for median-time-past to catch up (up to REFUND_MTP_LAG_SECONDS). The
    // background reconcile keeps retrying.
    return after
  }

  async getSwap(id: string): Promise<ArkadeLightningSwap | null> {
    const store = await this.store()
    const record = await store.get(id)
    return record ? this.toSwap(record, await store.getFundingMarker(id)) : null
  }

  async findByPaymentHash(paymentHash: string): Promise<ArkadeLightningSwap | null> {
    if (!paymentHash) return null
    let id: string | undefined
    try {
      id = await (await this.store()).idForPaymentHash(paymentHash)
    } catch {
      return null
    }
    return id ? this.getSwap(id) : null
  }

  async listSwaps(): Promise<ArkadeLightningSwap[]> {
    const store = await this.store()
    const [records, markers] = await Promise.all([store.list(), store.listFundingMarkers()])
    return records.map((r) => this.toSwap(r, markers.get(r.id))).sort((a, b) => b.createdAt - a.createdAt)
  }

  /** `marker`: this engine's funding marker; a marked send is never reported `quoted` or `cancelled`. */
  toSwap(record: ArkadeIntentsRecord, marker?: ArkadeIntentsFundingMarker): ArkadeLightningSwap {
    const quote = (record.quote ?? {}) as Record<string, unknown>
    const send = record.route === SEND_ROUTE
    const from = num(quote.from_amount) ?? 0
    const to = num(quote.to_amount) ?? 0
    const unfundedPhase = record.phase === 'prepared' || record.phase === 'cancelled'
    const fundingTxid = typeof record.fundingTxid === 'string' ? record.fundingTxid : marker?.fundingTxid
    return {
      id: record.id,
      direction: send ? 'send' : 'receive',
      status: send && marker && unfundedPhase ? 'pending' : statusOf(record.phase),
      phase: record.phase,
      invoice: typeof record.invoice === 'string' ? record.invoice : undefined,
      arkadeAmountSats: send ? num(record.fundAmountSats) ?? from : num(record.expectedAmountSats) ?? to,
      lightningAmountSats: send ? to : num(record.payAmountSats) ?? from,
      feeSats: Math.max(0, from - to),
      createdAt: num(record.createdAt) ?? 0,
      validUntil: num(quote.valid_until),
      refundLocktime: num(quote.refund_locktime),
      fundingTxid,
      resolvedTxid: typeof record.resolvedTxid === 'string' ? record.resolvedTxid : undefined,
      failureReason: typeof record.failureReason === 'string' ? record.failureReason : undefined,
      ...(send && num(quote.refund_locktime) != null ? { refundAvailableAt: num(quote.refund_locktime) } : {}),
      ...(record.phase === 'needs_recovery' ? { recoveryHint: RECOVERY_HINT } : {}),
    }
  }
}

export interface ArkadeLightningReconcileReport {
  settled: string[]
  refunded: string[]
  cancelled: string[]
  needsRecovery: string[]
  failed: string[]
  pending: string[]
  errors: { id: string; error: unknown }[]
}

/** Host status vocabulary for `getPaymentStatus`. */
export function transactionStatusOf(status: ArkadeLightningSwapStatus): 'pending' | 'confirmed' | 'failed' | 'cancelled' {
  switch (status) {
    case 'settled':
      return 'confirmed'
    case 'refunded':
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'pending'
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
