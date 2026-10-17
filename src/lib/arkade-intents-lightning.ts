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
import { ArkadeIntentsStore, type ArkadeIntentsRecord } from '../swap/arkade-intents-store'
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
}

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

export type ArkadeIntentsRefusalKind = 'below_minimum' | 'above_maximum' | 'no_capacity' | 'out_of_range' | 'other'

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

/** BOLT11 prefixes valid for an Arkade server network. */
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
}

export class ArkadeIntentsLightning {
  private timer: ReturnType<typeof setInterval> | null = null
  private card: { limits: CardLimits; at: number } | null = null
  private initPromise: Promise<ArkadeIntentsVenueLike | null> | null = null

  constructor(private readonly deps: ArkadeIntentsLightningDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000)
  }

  private store(): ArkadeIntentsStore {
    return this.deps.store ?? ArkadeIntentsStore.fromPlatform()
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
      ...(this.deps.store ? { store: this.deps.store } : {}),
    })
    // Resume whatever a previous session left pending.
    void this.reconcile().catch(() => {})
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
    this.card = null
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
    if (hrps && !hrps.includes(decoded.network.hrp)) {
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
    else if (reason === 'amount_out_of_range') {
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
    await this.store().linkPaymentHash(facts.paymentHash, id)
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
    return quote
  }

  /**
   * Step 2 of Ark -> LN: fund the quoted lockup. Call only after the user
   * approved the quote. Returns `pending`; the solver pays the invoice and
   * `reconcile` moves the swap to settled / refunded / failed.
   */
  async executeSend(id: string): Promise<ArkadeLightningSwap> {
    const venue = await this.venue()
    const record = await this.store().get(id)
    if (!record || record.route !== SEND_ROUTE) {
      throw new ProtocolError(`No Arkade Intents send quote ${id}`, 'ARKADE', 'QUOTE_NOT_FOUND')
    }
    if (record.phase !== 'prepared') {
      throw new ProtocolError(`Arkade Intents swap ${id} is already ${record.phase}`, 'ARKADE', 'QUOTE_USED')
    }
    const validUntil = num((record.quote as Record<string, unknown> | undefined)?.valid_until)
    if (validUntil != null && validUntil <= this.now()) {
      throw new ProtocolError('The quote expired before it was funded; request a new one', 'ARKADE', 'QUOTE_EXPIRED')
    }
    const address = record.address as string
    const amount = num(record.fundAmountSats)
    if (!address || !amount) {
      throw new ProtocolError(`Arkade Intents record ${id} has no funding instruction`, 'ARKADE', 'INVALID_QUOTE')
    }
    const fundingTxid = await this.deps.fund(address, amount)
    if (!fundingTxid) {
      throw new ProtocolError('Arkade send did not return a transaction ID', 'ARKADE', 'SEND_ERROR')
    }
    try {
      return this.toSwap(await venue.notifyFunded(id, fundingTxid))
    } catch (error) {
      // Funded but not handed to the manager: reconcile self-heals a prepared
      // record with chain evidence after its window, so report it pending.
      log.warn(`[ArkadeIntents] notifyFunded failed for ${id} after funding ${fundingTxid}:`, error)
      return { ...this.toSwap(record), status: 'pending', fundingTxid }
    }
  }

  /** LN -> Ark: a hold invoice from the solver. The claim runs from `reconcile`. */
  async createReceive(amountSats: number, opts: { maxFeeSats?: number } = {}): Promise<ArkadeLightningReceive> {
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
        amountSide: 'to',
        maxPayAmountSats: amountSats + this.feeCeiling(amountSats, opts.maxFeeSats),
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
    const id = String(prepared.record?.id)
    await this.store().linkPaymentHash(facts.paymentHash, id)
    // Arm the watcher now: the payer is external, so there is no "dispatched"
    // moment to wait for, and an unpaid invoice simply ends `cancelled`.
    await venue.notifyFunded(id)
    const payAmountSats = Number(prepared.payAmountSats)
    const expectedAmountSats = Number(prepared.summary?.toAmountSats ?? amountSats)
    return {
      id,
      invoice,
      paymentHash: facts.paymentHash,
      payAmountSats,
      expectedAmountSats,
      feeSats: Math.max(0, payAmountSats - expectedAmountSats),
      invoiceExpiresAt: Number(prepared.invoiceExpiresAt ?? facts.expiresAt),
    }
  }

  /** One pass over pending swaps: claims receives, settles/refunds sends. */
  async reconcile(): Promise<ArkadeLightningReconcileReport | null> {
    if (!arkadeIntentsClientManager.isInitialized()) return null
    const report = await arkadeIntentsClientManager.getVenue().reconcile()
    return { ...report, failed: report.failed ?? [] }
  }

  /** Push a refund for a stalled send (no-op until the refund locktime). */
  async refundSend(id: string): Promise<ArkadeLightningSwap> {
    return this.toSwap(await (await this.venue()).refundSend(id))
  }

  async getSwap(id: string): Promise<ArkadeLightningSwap | null> {
    const record = await this.store().get(id)
    return record ? this.toSwap(record) : null
  }

  async findByPaymentHash(paymentHash: string): Promise<ArkadeLightningSwap | null> {
    if (!paymentHash) return null
    let id: string | undefined
    try {
      id = await this.store().idForPaymentHash(paymentHash)
    } catch {
      return null
    }
    return id ? this.getSwap(id) : null
  }

  async listSwaps(): Promise<ArkadeLightningSwap[]> {
    const records = await this.store().list()
    return records.map((r) => this.toSwap(r)).sort((a, b) => b.createdAt - a.createdAt)
  }

  toSwap(record: ArkadeIntentsRecord): ArkadeLightningSwap {
    const quote = (record.quote ?? {}) as Record<string, unknown>
    const send = record.route === SEND_ROUTE
    const from = num(quote.from_amount) ?? 0
    const to = num(quote.to_amount) ?? 0
    return {
      id: record.id,
      direction: send ? 'send' : 'receive',
      status: statusOf(record.phase),
      phase: record.phase,
      invoice: typeof record.invoice === 'string' ? record.invoice : undefined,
      arkadeAmountSats: send ? num(record.fundAmountSats) ?? from : num(record.expectedAmountSats) ?? to,
      lightningAmountSats: send ? to : num(record.payAmountSats) ?? from,
      feeSats: Math.max(0, from - to),
      createdAt: num(record.createdAt) ?? 0,
      validUntil: num(quote.valid_until),
      refundLocktime: num(quote.refund_locktime),
      fundingTxid: typeof record.fundingTxid === 'string' ? record.fundingTxid : undefined,
      resolvedTxid: typeof record.resolvedTxid === 'string' ? record.resolvedTxid : undefined,
      failureReason: typeof record.failureReason === 'string' ? record.failureReason : undefined,
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
