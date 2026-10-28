/**
 * Settlement polling for Spark Lightning sends.
 *
 * `payLightningInvoice` only DISPATCHES to the SSP; settlement is async and can
 * still fail. Reporting 'confirmed' on dispatch makes WebLN/NWC callers believe
 * zaps succeeded when they never settled, and denies them the preimage NIP-47
 * requires — so both Spark adapters poll here until a terminal state.
 */

import { decodeBolt11Invoice } from './bolt11'
import { log } from './log'
import { preimageMatchesPaymentHash } from '../lightning/preimages'

// LightningSendRequestStatus values (SSP request lifecycle). A success status
// says the SSP believes the invoice settled; only a preimage hashing to the
// invoice's payment hash proves it. Failure (including the swap-return refund
// path) means it never will.
const LIGHTNING_SEND_SUCCESS_STATUSES = new Set([
  'LIGHTNING_PAYMENT_SUCCEEDED',
  'PREIMAGE_PROVIDED',
  'TRANSFER_COMPLETED',
])
const LIGHTNING_SEND_FAILURE_STATUSES = new Set([
  'USER_TRANSFER_VALIDATION_FAILED',
  'LIGHTNING_PAYMENT_FAILED',
  'PREIMAGE_PROVIDING_FAILED',
  'TRANSFER_FAILED',
  'PENDING_USER_SWAP_RETURN',
  'USER_SWAP_RETURNED',
  'USER_SWAP_RETURN_FAILED',
])
const LIGHTNING_SETTLEMENT_TIMEOUT_MS = 45_000
const LIGHTNING_SETTLEMENT_POLL_MS = 2_000

export interface LightningSettlement {
  /** `confirmed` only with a preimage whose SHA-256 is the invoice's payment hash. */
  status: 'confirmed' | 'pending' | 'failed'
  rawStatus: string
  preimage: string
  feeSats: number
}

/**
 * What a LightningSendRequest must match to count as the payment we made. A
 * record the SSP returns for another request id or another invoice is ignored,
 * and `confirmed` requires a preimage for `paymentHash` (decoded from `invoice`
 * when not given, else from the record's own `encodedInvoice`).
 */
export interface LightningSendBinding {
  /** Bare uuid or `SparkLightningSendRequest:uuid` entity id. */
  id?: string
  /** The BOLT11 that was sent. */
  invoice?: string
  /** Hex payment hash the preimage must hash to. */
  paymentHash?: string
}

const LIGHTNING_SEND_ENTITY_PREFIX = 'SparkLightningSendRequest:'

function bareRequestId(id: unknown): string {
  const value = String(id ?? '').trim()
  return (value.includes(':') ? value.split(':').pop()! : value).toLowerCase()
}

function normalizeInvoice(invoice: unknown): string {
  return String(invoice ?? '').trim().toLowerCase()
}

/**
 * Payment hash of a BOLT11, or null when the invoice does not decode (checksum,
 * signature or payment-hash field invalid). Settlement of an invoice without a
 * payment hash can never be proven, so callers must fail closed.
 */
export function lightningInvoicePaymentHash(invoice: string): string | null {
  try {
    return decodeBolt11Invoice(invoice.trim()).paymentHash.toLowerCase()
  } catch {
    return null
  }
}

/** Whether `req` is the lightning send request `binding` describes (id and invoice, when known). */
export function lightningSendRecordMatches(
  req: Record<string, unknown>,
  binding: LightningSendBinding,
): boolean {
  if (binding.id && req.id != null && bareRequestId(req.id) !== bareRequestId(binding.id)) {
    return false
  }
  if (
    binding.invoice &&
    req.encodedInvoice != null &&
    normalizeInvoice(req.encodedInvoice) !== normalizeInvoice(binding.invoice)
  ) {
    return false
  }
  return true
}

function expectedPaymentHash(req: Record<string, unknown>, binding: LightningSendBinding): string | null {
  if (binding.paymentHash) return binding.paymentHash.toLowerCase()
  if (binding.invoice) return lightningInvoicePaymentHash(binding.invoice)
  if (typeof req.encodedInvoice === 'string' && req.encodedInvoice) {
    return lightningInvoicePaymentHash(req.encodedInvoice)
  }
  return null
}

/**
 * Read a terminal settlement out of a LightningSendRequest, or null while in
 * flight. A record that does not match `binding` yields null. `confirmed` needs
 * a 32-byte preimage whose SHA-256 equals the payment hash: a success status
 * alone, or an empty/unrelated preimage, is not proof that the invoice was paid
 * and stays non-terminal (the poller reports `pending`).
 */
export function readLightningSettlement(
  req: Record<string, unknown>,
  binding: LightningSendBinding = {},
): LightningSettlement | null {
  if (!lightningSendRecordMatches(req, binding)) return null
  const rawStatus = String(req.status ?? '')
  const preimage = String(req.paymentPreimage ?? '')
  const fee = req.fee as { originalValue?: number; originalUnit?: string } | undefined
  const feeSats =
    fee?.originalUnit === 'MILLISATOSHI'
      ? Math.ceil((fee.originalValue ?? 0) / 1000)
      : Number(fee?.originalValue ?? 0)
  const paymentHash = expectedPaymentHash(req, binding)
  if (paymentHash && preimageMatchesPaymentHash(preimage, paymentHash)) {
    return { status: 'confirmed', rawStatus, preimage: preimage.toLowerCase(), feeSats }
  }
  if (LIGHTNING_SEND_FAILURE_STATUSES.has(rawStatus)) {
    return { status: 'failed', rawStatus, preimage: '', feeSats }
  }
  // A success status normally precedes PREIMAGE_PROVIDED, so a missing preimage
  // is an ordinary in-flight state; a preimage that does not fit the invoice,
  // or an invoice whose hash cannot be read, is an anomaly worth a trace.
  if (preimage && LIGHTNING_SEND_SUCCESS_STATUSES.has(rawStatus)) {
    log.warn(
      `[SparkLightning] send ${bareRequestId(req.id)} reports ${rawStatus} ` +
        (paymentHash
          ? 'with a preimage that does not hash to the invoice payment hash'
          : 'but the invoice payment hash is unknown') +
        '; not treating it as paid',
    )
  }
  return null
}

/**
 * Poll the SSP until the lightning send request reaches a terminal state. Returns
 * 'pending' (never throws) when the deadline passes or the lookup is unavailable —
 * the payment may still settle, so failure must not be reported.
 *
 * `wallet` is any object exposing `getLightningSendRequest(id)`; `id` accepts a bare
 * uuid or the WDK-style `SparkLightningSendRequest:uuid` entity id.
 */
export async function waitForLightningSendSettlement(
  wallet: unknown,
  id: string,
  initial: Record<string, unknown>,
  binding: LightningSendBinding = {},
): Promise<LightningSettlement> {
  const bound: LightningSendBinding = { id, ...binding }
  const settled = readLightningSettlement(initial, bound)
  if (settled) return settled

  const pending = (last: Record<string, unknown>): LightningSettlement => ({
    status: 'pending',
    rawStatus: String(last.status ?? ''),
    preimage: '',
    feeSats: 0,
  })

  const lookupId = id.includes(':') ? id.split(':').pop()! : id
  const lookup = (
    wallet as { getLightningSendRequest?: (id: string) => Promise<unknown> }
  ).getLightningSendRequest?.bind(wallet)
  if (!lookupId || !lookup) return pending(initial)

  let last = initial
  const deadline = Date.now() + LIGHTNING_SETTLEMENT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LIGHTNING_SETTLEMENT_POLL_MS))
    try {
      const req = (await lookup(lookupId)) as Record<string, unknown> | null | undefined
      if (req && !lightningSendRecordMatches(req, bound)) {
        log.warn(`[SparkLightning] send ${lookupId} lookup returned a record for another request; ignoring it`)
      } else if (req) {
        last = req
        const result = readLightningSettlement(req, bound)
        if (result) return result
      }
    } catch (err) {
      log.warn('[SparkLightning] send request lookup failed:', err)
    }
  }
  log.warn(
    `[SparkLightning] send ${lookupId} not terminal after ${LIGHTNING_SETTLEMENT_TIMEOUT_MS}ms (status=${String(last.status ?? '')})`,
  )
  return pending(last)
}

const USER_REQUEST_PAGE_SIZE = 50
const USER_REQUEST_MAX_PAGES = 4

/** Whether a payment id names an SSP lightning send request rather than a Spark transfer. */
export function isLightningSendRequestId(id: string): boolean {
  return id.startsWith(LIGHTNING_SEND_ENTITY_PREFIX)
}

/**
 * The operators keep one preimage swap per payment hash, so a second
 * `payLightningInvoice` for an invoice this wallet already submitted — settled,
 * in flight, or failed and refunded — is rejected with ALREADY_EXISTS.
 */
export function isDuplicatePreimageSwapError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /preimage request already exists/i.test(msg) ||
    (/ALREADY_EXISTS/.test(msg) && /preimage_swap/i.test(msg))
}

/**
 * Find this wallet's existing lightning send request for `invoice`, newest
 * first, or null when none is found (or the lookup is unavailable).
 */
export async function findLightningSendForInvoice(
  wallet: unknown,
  invoice: string,
): Promise<Record<string, unknown> | null> {
  const getUserRequests = (
    wallet as { getUserRequests?: (params: Record<string, unknown>) => Promise<unknown> }
  ).getUserRequests?.bind(wallet)
  if (!getUserRequests) return null

  const target = invoice.trim().toLowerCase()
  let after: string | undefined
  for (let page = 0; page < USER_REQUEST_MAX_PAGES; page++) {
    let conn: { entities?: Record<string, unknown>[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } | null
    try {
      conn = (await getUserRequests({
        first: USER_REQUEST_PAGE_SIZE,
        ...(after ? { after } : {}),
        types: ['LIGHTNING_SEND'],
      })) as typeof conn
    } catch (err) {
      log.warn('[SparkLightning] user request lookup failed:', err)
      return null
    }
    const match = conn?.entities?.find(
      (e) => String(e.encodedInvoice ?? '').toLowerCase() === target,
    )
    if (match) return match
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) return null
    after = conn.pageInfo.endCursor
  }
  return null
}

/**
 * Current status of a lightning send request, or null when the wallet cannot
 * look it up, the SSP does not know the id, or it answers with a record for
 * another request. `confirmed` requires a preimage for the payment hash of the
 * record's invoice (or of `binding.invoice`/`binding.paymentHash` when given);
 * a success status without one reads as `pending`.
 */
export async function getLightningSendStatus(
  wallet: unknown,
  id: string,
  binding: LightningSendBinding = {},
): Promise<{ status: LightningSettlement['status']; feeSats: number; timestamp: number } | null> {
  const lookup = (
    wallet as { getLightningSendRequest?: (id: string) => Promise<unknown> }
  ).getLightningSendRequest?.bind(wallet)
  if (!lookup) return null
  const req = (await lookup(id.includes(':') ? id.split(':').pop()! : id)) as
    | Record<string, unknown>
    | null
    | undefined
  if (!req) return null
  const bound: LightningSendBinding = { id, ...binding }
  if (!lightningSendRecordMatches(req, bound)) {
    log.warn(`[SparkLightning] send ${bareRequestId(id)} lookup returned a record for another request`)
    return null
  }
  const settled = readLightningSettlement(req, bound)
  const created = Date.parse(String(req.createdAt ?? ''))
  return {
    status: settled?.status ?? 'pending',
    feeSats: settled?.feeSats ?? 0,
    timestamp: Number.isFinite(created) ? created : 0,
  }
}
