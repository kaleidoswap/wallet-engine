/**
 * Settlement polling for Spark Lightning sends.
 *
 * `payLightningInvoice` only DISPATCHES a payment to the SSP; settlement is
 * asynchronous and can still fail (no route, fee cap, refund path). Reporting
 * 'confirmed' on dispatch makes WebLN/NWC callers believe zaps succeeded when
 * they never settled, and denies them the preimage NIP-47 requires. Both the
 * native SparkAdapter and the SparkWdkAdapter poll here until the send
 * request reaches a terminal state.
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
 * Poll the SSP until the lightning send request reaches a terminal state.
 * Returns 'pending' (never throws) when the deadline passes or the lookup is
 * unavailable — the payment may still settle, so we must not report failure.
 *
 * `wallet` is any object exposing the native SDK's
 * `getLightningSendRequest(id)`; `id` accepts both a bare uuid and the
 * WDK-style `SparkLightningSendRequest:uuid` entity id.
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
