/**
 * Flashnet Orchestra REST API Client
 *
 * Cross-chain swap orchestration: stablecoins (USDC/USDT) and native assets
 * (ETH/SOL/TRX) on EVM/Solana/Tron ↔ BTC/USDB on Spark.
 *
 * API docs: https://docs.flashnet.xyz/products/orchestration/overview
 * Base URL: https://orchestration.flashnet.xyz
 *
 * Ported from rate-extension/src/protocols/spark/orchestra-client.ts. The API
 * key is NOT read from a build-time env var here — the engine is platform-
 * agnostic, so the consumer injects it once at startup via `setOrchestraApiKey()`
 * (the extension supplies its inlined `VITE_FLASHNET_ORCHESTRA_KEY`).
 */

import { log } from './log'

const BASE_URL = 'https://orchestration.flashnet.xyz'

/**
 * Orchestra API key, injected by the consumer. PUBLIC-by-design in the
 * extension (shipped in the bundle) — the seam simply keeps the build-time
 * env-var read out of the engine. Empty until `setOrchestraApiKey()` runs;
 * every authed endpoint (createQuote/getOrder/submitOrder/getStatus) 401s
 * without it.
 */
let apiKey = ''

/**
 * Register the Orchestra API key. Call once at startup. Warns if given an
 * empty value so a misconfigured build is obvious instead of surfacing as a
 * runtime 401 that looks like a network failure.
 */
export function setOrchestraApiKey(key: string | null | undefined): void {
  apiKey = key ?? ''
  if (!apiKey) {
    log.warn(
      '[Orchestra] API key is empty — Bridge quote/submit calls will fail with HTTP 401. ' +
        'Pass a key to setOrchestraApiKey() at startup.',
    )
  }
}

/**
 * Stable marker embedded in the auth-error message. Only `Error.message`
 * survives the background-SW → UI message boundary (see background-protocol.ts:
 * `sendResponse({ error: error?.message })`), so the UI matches on this token
 * rather than `instanceof OrchestraAuthError`.
 */
export const ORCHESTRA_AUTH_ERROR_CODE = 'ORCHESTRA_AUTH_FAILED'

/**
 * Thrown when an authed Orchestra call fails due to a missing/invalid API key
 * (HTTP 401/403). Callers can detect this to show a "Bridge unavailable /
 * not configured" message instead of a generic "Quote failed".
 */
export class OrchestraAuthError extends Error {
  readonly status: number
  constructor(status: number) {
    super(
      `${ORCHESTRA_AUTH_ERROR_CODE}: Bridge is not configured or unavailable. ` +
        'The cross-chain service rejected the request (authentication failed).',
    )
    this.name = 'OrchestraAuthError'
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestraRouteAsset {
  chain: string
  asset: string
  contractAddress?: string
  decimals: number
  chainId?: number
}

export interface OrchestraRoute {
  sourceChain: string
  sourceAsset: string
  destinationChain: string
  destinationAsset: string
  source?: OrchestraRouteAsset
  destination?: OrchestraRouteAsset
}

export interface OrchestraEstimate {
  estimatedOut: string
  feeAmount: string
  feeBps: number
  totalFeeAmount: string
  feeAsset: string
  route: OrchestraRoute
}

export interface OrchestraQuote {
  quoteId: string
  depositAddress: string
  amountIn: string
  estimatedOut: string
  feeAmount: string
  feeBps: number
  totalFeeAmount: string
  feeAsset: string
  route: OrchestraRoute
  expiresAt: string
}

export type OrchestraOrderStatus =
  | 'processing'
  | 'confirming'
  | 'bridging'
  | 'swapping'
  | 'awaiting_approval'
  | 'refunding'
  | 'delivering'
  | 'completed'
  | 'failed'
  | 'refunded'

export interface OrchestraOrderStage {
  stage: string
  timestamp: string
}

export interface OrchestraOrder {
  id: string
  quoteId: string
  status: OrchestraOrderStatus
  amountIn?: string
  amountOut?: string
  depositAddress?: string
  recipientAddress?: string
  route?: OrchestraRoute
  stages?: OrchestraOrderStage[]
  createdAt?: string
  updatedAt?: string
}

export interface OrchestraOrderLookup {
  quote: OrchestraQuote | null
  order: OrchestraOrder | null
  stages?: OrchestraOrderStage[]
}

export interface CreateQuoteParams {
  sourceChain: string
  sourceAsset: string
  destinationChain: string
  destinationAsset: string
  amount: string
  recipientAddress: string
  slippageBps?: number
}

export interface SubmitOrderParams {
  quoteId: string
  txHash?: string
  sourceAddress?: string
  sparkTxHash?: string
  sourceSparkAddress?: string
  bitcoinTxid?: string
  bitcoinVout?: number
}

export interface EstimateParams {
  sourceChain: string
  sourceAsset: string
  destinationChain: string
  destinationAsset: string
  amount: string
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  if (!apiKey) return {}
  return { Authorization: `Bearer ${apiKey}` }
}

function idempotencyHeader(prefix: string): Record<string, string> {
  return { 'X-Idempotency-Key': `${prefix}:${crypto.randomUUID()}` }
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  opts?: { params?: Record<string, string>; body?: unknown; auth?: boolean; idempotency?: string },
): Promise<T> {
  const url = new URL(path, BASE_URL)
  if (opts?.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined) url.searchParams.set(k, v)
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts?.auth) Object.assign(headers, authHeaders())
  if (opts?.idempotency) Object.assign(headers, idempotencyHeader(opts.idempotency))

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // An auth failure on an authed call almost always means the API key was
    // not injected (or is invalid). Throw a specific error so the UI can
    // distinguish "Bridge not configured" from a transient quote error.
    if (opts?.auth && (res.status === 401 || res.status === 403)) {
      throw new OrchestraAuthError(res.status)
    }
    throw new Error(`Orchestra API ${method} ${path} failed (${res.status}): ${text}`)
  }

  return res.json()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List all available cross-chain routes. No auth required. */
export async function getRoutes(): Promise<OrchestraRoute[]> {
  const res = await request<{ routes: OrchestraRoute[] } | OrchestraRoute[]>(
    'GET',
    '/v1/orchestration/routes',
  )
  // API wraps in { routes: [...] }
  return Array.isArray(res) ? res : res.routes
}

/** Get a lightweight price estimate. No auth required. */
export async function getEstimate(params: EstimateParams): Promise<OrchestraEstimate> {
  return request<OrchestraEstimate>('GET', '/v1/orchestration/estimate', {
    params: {
      sourceChain: params.sourceChain,
      sourceAsset: params.sourceAsset,
      destinationChain: params.destinationChain,
      destinationAsset: params.destinationAsset,
      amount: params.amount,
    },
  })
}

/** Create a durable quote with deposit address. Auth required. TTL ~30 min. */
export async function createQuote(params: CreateQuoteParams): Promise<OrchestraQuote> {
  return request<OrchestraQuote>('POST', '/v1/orchestration/quote', {
    body: {
      sourceChain: params.sourceChain,
      sourceAsset: params.sourceAsset,
      destinationChain: params.destinationChain,
      destinationAsset: params.destinationAsset,
      amount: params.amount,
      recipientAddress: params.recipientAddress,
      slippageBps: params.slippageBps ?? 100,
    },
    auth: true,
    idempotency: 'quote:create',
  })
}

/** Look up a quote and its associated order (if any). Auth required. */
export async function getOrder(quoteId: string): Promise<OrchestraOrderLookup> {
  return request<OrchestraOrderLookup>('GET', '/v1/orchestration/order', {
    params: { quoteId },
    auth: true,
  })
}

/** Submit deposit proof to create an order from a quote. Auth required. */
export async function submitOrder(
  params: SubmitOrderParams,
): Promise<{ orderId: string; status: string }> {
  return request<{ orderId: string; status: string }>('POST', '/v1/orchestration/submit', {
    body: params,
    auth: true,
    idempotency: 'submit',
  })
}

/**
 * Check order status by ID, quoteId, or txHash.
 *
 * The Flashnet orchestration `/v1/orchestration/status` endpoint historically
 * returned a flat `OrchestraOrder`, but the live API now wraps the response
 * as `{ order: OrchestraOrder, stages?: OrchestraOrderStage[] }` (same shape
 * as `/order`). Both forms have been observed in the wild — we unwrap defensively
 * so the bridge tracking poller sees a real `status` field either way.
 * Without this, `status` is `undefined`, the poller silently keeps showing
 * the stale local status (e.g. "swapping") even after the order completes.
 */
export async function getStatus(query: {
  id?: string
  quoteId?: string
  txHash?: string
}): Promise<OrchestraOrder> {
  const params: Record<string, string> = {}
  if (query.id) params.id = query.id
  else if (query.quoteId) params.quoteId = query.quoteId
  else if (query.txHash) params.txHash = query.txHash
  const raw = await request<OrchestraOrder | OrchestraOrderLookup>(
    'GET',
    '/v1/orchestration/status',
    { params, auth: true },
  )
  // Wrapped shape: pull the order, attach stages so callers can use them
  // for finer-grained progress UI without a second request.
  if (raw && typeof raw === 'object' && 'order' in raw && raw.order) {
    const wrapped = raw as OrchestraOrderLookup
    return wrapped.stages ? { ...wrapped.order!, stages: wrapped.stages } : wrapped.order!
  }
  return raw as OrchestraOrder
}
