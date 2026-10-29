/**
 * Esplora chain-data provider
 * ---------------------------
 * `IChainDataProvider` over the Esplora HTTP API (Blockstream, mempool.space,
 * electrs), one base URL per chain. Pure TypeScript, no SDK: the same endpoint a
 * host hands the swap SDK for broadcasting serves the confirmation reads here.
 *
 * Fails closed: an HTTP error, a malformed body or a missing URL for the chain
 * rejects. Nothing is cached or retried, and requests carry no cookies, no
 * credentials and follow no redirects, matching `@kaleidorg/swap-sdk/chain-data`.
 */

import type {
  ChainKind,
  ChainOutspend,
  ChainTransaction,
  ChainTxInput,
  ChainTxOutput,
  IChainDataProvider,
} from '../ports'

export interface EsploraChainDataOptions {
  /** Esplora base URL for Bitcoin, e.g. `https://blockstream.info/api`. */
  bitcoinUrl?: string
  /** Esplora base URL for Liquid, e.g. `https://blockstream.info/liquid/api`. */
  liquidUrl?: string
  /** Per-request deadline, body included. Default 30s. */
  timeoutMs?: number
  /** Transport override; defaults to the global `fetch`. */
  fetch?: typeof fetch
}

export class EsploraChainDataError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'EsploraChainDataError'
  }
}

const HEX64 = /^[0-9a-f]{64}$/
const HEX = /^(?:[0-9a-f]{2})*$/

function normalizeBase(url: string): string {
  const base = new URL(url)
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new TypeError('Esplora base URL must be HTTP(S), without credentials, query or fragment')
  }
  return base.href.replace(/\/+$/, '')
}

function requireUint(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new EsploraChainDataError(`Esplora ${what} is not a non-negative integer`)
  }
  return value
}

function requireHex(value: unknown, what: string, re: RegExp): string {
  if (typeof value !== 'string' || !re.test(value.toLowerCase())) {
    throw new EsploraChainDataError(`Esplora ${what} is not valid hex`)
  }
  return value.toLowerCase()
}

/** Parse one `GET /tx/:txid` body plus its `GET /tx/:txid/hex` counterpart. */
export function parseEsploraTransaction(raw: unknown, hex: string, txid: string): ChainTransaction {
  const tx = raw as Record<string, unknown>
  if (!tx || typeof tx !== 'object') {
    throw new EsploraChainDataError('Esplora transaction is not an object')
  }
  const id = requireHex(tx.txid, 'txid', HEX64)
  if (id !== txid) {
    throw new EsploraChainDataError(`Esplora returned transaction ${id} for ${txid}`)
  }
  if (!Array.isArray(tx.vin) || !Array.isArray(tx.vout)) {
    throw new EsploraChainDataError('Esplora transaction lacks vin/vout')
  }
  const vin: ChainTxInput[] = tx.vin.map((input: Record<string, unknown>, i) => {
    const witness = Array.isArray(input?.witness) ? input.witness : []
    return {
      txid: requireHex(input?.txid, `vin[${i}].txid`, HEX64),
      vout: requireUint(input?.vout, `vin[${i}].vout`),
      witness: witness.map((item, j) => requireHex(item, `vin[${i}].witness[${j}]`, HEX)),
    }
  })
  const vout: ChainTxOutput[] = tx.vout.map((output: Record<string, unknown>, i) => {
    const out: ChainTxOutput = {
      scriptPubKey: requireHex(output?.scriptpubkey, `vout[${i}].scriptpubkey`, HEX),
    }
    // Liquid shows `valuecommitment` instead of `value` on a blinded output.
    if (output?.value !== undefined && output?.value !== null) {
      out.valueSat = requireUint(output.value, `vout[${i}].value`)
    } else if (typeof output?.valuecommitment !== 'string') {
      throw new EsploraChainDataError(`Esplora vout[${i}] has neither value nor valuecommitment`)
    }
    return out
  })
  const status = tx.status as Record<string, unknown> | undefined
  const result: ChainTransaction = { txid: id, hex: requireHex(hex.trim(), 'tx hex', HEX), vin, vout }
  if (status?.confirmed === true) {
    result.blockHeight = requireUint(status.block_height, 'status.block_height')
  }
  return result
}

/** Parse one `GET /tx/:txid/outspend/:vout` body. */
export function parseEsploraOutspend(raw: unknown): ChainOutspend {
  const body = raw as Record<string, unknown>
  if (!body || typeof body !== 'object' || typeof body.spent !== 'boolean') {
    throw new EsploraChainDataError('Esplora outspend is malformed')
  }
  if (!body.spent) return { spent: false }
  return {
    spent: true,
    txid: requireHex(body.txid, 'outspend.txid', HEX64),
    vin: requireUint(body.vin, 'outspend.vin'),
  }
}

export class EsploraChainDataProvider implements IChainDataProvider {
  private readonly bases: Partial<Record<ChainKind, string>> = {}
  private readonly timeoutMs: number
  private readonly fetchImpl?: typeof fetch

  constructor(options: EsploraChainDataOptions) {
    if (options.bitcoinUrl) this.bases.bitcoin = normalizeBase(options.bitcoinUrl)
    if (options.liquidUrl) this.bases.liquid = normalizeBase(options.liquidUrl)
    this.timeoutMs = options.timeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('timeoutMs must be a positive integer')
    }
    this.fetchImpl = options.fetch
  }

  /** True when a base URL is configured for `chain`. */
  serves(chain: ChainKind): boolean {
    return this.bases[chain] !== undefined
  }

  async tipHeight(chain: ChainKind): Promise<number> {
    const text = (await this.get(chain, 'blocks/tip/height')).trim()
    if (!/^(0|[1-9][0-9]*)$/.test(text) || Number(text) > 4294967295) {
      throw new EsploraChainDataError('Esplora tip height is malformed')
    }
    return Number(text)
  }

  async getTransaction(chain: ChainKind, txid: string): Promise<ChainTransaction | null> {
    const id = requireHex(txid, 'txid', HEX64)
    let json: string
    let hex: string
    try {
      ;[json, hex] = await Promise.all([this.get(chain, `tx/${id}`), this.get(chain, `tx/${id}/hex`)])
    } catch (error) {
      if (error instanceof EsploraChainDataError && error.status === 404) return null
      throw error
    }
    return parseEsploraTransaction(parseJson(json), hex, id)
  }

  async getOutspend(chain: ChainKind, txid: string, vout: number): Promise<ChainOutspend> {
    const id = requireHex(txid, 'txid', HEX64)
    const index = requireUint(vout, 'vout')
    return parseEsploraOutspend(parseJson(await this.get(chain, `tx/${id}/outspend/${index}`)))
  }

  private async get(chain: ChainKind, path: string): Promise<string> {
    const base = this.bases[chain]
    if (!base) {
      throw new EsploraChainDataError(`No Esplora URL configured for the ${chain} chain`)
    }
    const request = this.fetchImpl ?? globalThis.fetch
    if (typeof request !== 'function') {
      throw new EsploraChainDataError('No fetch implementation available for Esplora reads')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await request(`${base}/${path}`, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new EsploraChainDataError(
          `Esplora GET /${path} failed (${response.status})`,
          response.status
        )
      }
      return await response.text()
    } finally {
      clearTimeout(timer)
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new EsploraChainDataError('Esplora response is not valid JSON')
  }
}
