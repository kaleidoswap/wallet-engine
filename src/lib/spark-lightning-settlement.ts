/**
 * Settlement polling for Spark Lightning sends.
 *
 * `payLightningInvoice` only DISPATCHES to the SSP; settlement is async and can
 * still fail. Reporting 'confirmed' on dispatch makes WebLN/NWC callers believe
 * zaps succeeded when they never settled, and denies them the preimage NIP-47
 * requires — so both Spark adapters poll here until a terminal state.
 */

import { log } from './log'

// LightningSendRequestStatus values (SSP request lifecycle). Success means the
// invoice settled and a preimage exists; failure (including the swap-return
// refund path) means it never will.
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
  status: 'confirmed' | 'pending' | 'failed'
  rawStatus: string
  preimage: string
  feeSats: number
}

/** Read a terminal settlement out of a LightningSendRequest, or null while in flight. */
export function readLightningSettlement(req: Record<string, unknown>): LightningSettlement | null {
  const rawStatus = String(req.status ?? '')
  const preimage = String(req.paymentPreimage ?? '')
  const fee = req.fee as { originalValue?: number; originalUnit?: string } | undefined
  const feeSats =
    fee?.originalUnit === 'MILLISATOSHI'
      ? Math.ceil((fee.originalValue ?? 0) / 1000)
      : Number(fee?.originalValue ?? 0)
  if (preimage || LIGHTNING_SEND_SUCCESS_STATUSES.has(rawStatus)) {
    return { status: 'confirmed', rawStatus, preimage, feeSats }
  }
  if (LIGHTNING_SEND_FAILURE_STATUSES.has(rawStatus)) {
    return { status: 'failed', rawStatus, preimage: '', feeSats }
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
): Promise<LightningSettlement> {
  const settled = readLightningSettlement(initial)
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
      if (req) {
        last = req
        const result = readLightningSettlement(req)
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

const LIGHTNING_SEND_ENTITY_PREFIX = 'SparkLightningSendRequest:'
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
 * look it up or the SSP does not know the id.
 */
export async function getLightningSendStatus(
  wallet: unknown,
  id: string,
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
  const settled = readLightningSettlement(req)
  const created = Date.parse(String(req.createdAt ?? ''))
  return {
    status: settled?.status ?? 'pending',
    feeSats: settled?.feeSats ?? 0,
    timestamp: Number.isFinite(created) ? created : 0,
  }
}
