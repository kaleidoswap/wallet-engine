/**
 * RgbLibWasmAdapter
 * -----------------
 * RGB-L1 backed by the browser/wasm rgb-lib build (`@utexo/rgb-lib-wasm`) rather
 * than the native addon in `RgbLibWdkAdapter`. Same protocol surface and the same
 * `RgbCore` translation, so the two cannot drift; the wasm build persists to
 * IndexedDB and needs no filesystem or Node runtime, which is what makes RGB-L1
 * work in an MV3 service worker.
 *
 * The host injects an already-initialized module via
 * `registerWdkModule('@utexo/rgb-lib-wasm', () => initializedModule)`, so this
 * adapter never touches fetch/URLs. No rgb-lib types cross the contract.
 */

import { Address as BtcAddress, OutScript, NETWORK, TEST_NETWORK } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { IProtocolAdapter, BaseProtocolConfig } from '../IProtocolAdapter'
import type {
  IRgbHtlcOperations,
  RgbHtlcOperation,
  RgbHtlcAllocation,
  RgbReceivedMint,
  RgbPsbtSummary,
  IRgbPreviewOperations,
} from '../IProtocolAdapter'
import {
  ProtocolType,
  Layer,
  UnifiedAsset,
  UnifiedTransaction,
  InvoiceRequest,
  Invoice,
  DecodedInvoice,
  PaymentRequest,
  PaymentResult,
  PaymentStatus,
  Address,
  ConnectionInfo,
  TransactionFilter,
  TransactionStatus,
  NodeInfo,
  ProtocolError,
} from '../../types/base'
import { getCapabilities } from '../../capabilities'
import { PROTOCOL_OPERATIONS } from '../../capabilities/operations'
import { loadWdkModule } from './moduleLoader'
import { rgbBtcAsset, rgbNiaAsset, rgbAssetBalance, RGB_L1_PROFILE } from './RgbCore'
import type { RgbBalanceLike } from './RgbCore'
import { BaseWdkAdapter } from './BaseWdkAdapter'
import { defaultRgbFeeRate } from '../../lib/rgb-fee-policy'
import { applyTransactionFilter } from '../../lib/transaction-filter'

export interface RgbLibWasmAdapterConfig extends BaseProtocolConfig {
  protocol: 'RGB_L1'
  /** BIP-39 mnemonic for this wallet. */
  mnemonic: string
  /** RGB indexer (electrum/esplora) URL — required to go online. */
  indexerUrl: string
  /** RGB proxy / transport endpoints for blinded receives; rgb-lib defaults when omitted. */
  transportEndpoints?: string[]
  /**
   * IndexedDB namespace key (rgb-lib's `dataDir`), so multiple wallets/networks
   * coexist. Defaults to a network-scoped name.
   */
  dataDir?: string
  /** Max allocations per UTXO (rgb-lib tuning). Defaults to 5. */
  maxAllocationsPerUtxo?: number
  /**
   * Skip rgb-lib's go-online consistency check (DB vs RGB stock, then a full
   * scan). It catches a store that drifted from the chain but costs a full scan
   * on every connect. Defaults to false.
   */
  skipConsistencyCheck?: boolean
  /**
   * EVM chains of the bridges of BFA assets, by EIP-155 chain ID. A received
   * BFA mint stays pending until its lock is checked on its chain. Ignored on
   * mainnet, where rgb-lib refuses the BFA schema. An unreachable endpoint does
   * not keep the wallet offline: it goes online without EVM chains.
   */
  evmChains?: Record<string, RgbEvmChain>
}

/** An EVM chain rgb-lib checks BFA mint locks on. */
export interface RgbEvmChain {
  rpcUrl: string
  minMintLockBlocks: number
  maxMintLockBlocks: number
}

/** The fungible asset lists of rgb-lib's `listAssets`, or its array form. */
function fungibleAssets(res: any): any[] {
  return Array.isArray(res) ? res : [...(res?.nia ?? []), ...(res?.ifa ?? []), ...(res?.bfa ?? [])]
}

/** Map the engine network string → rgb-lib's network enum casing. */
function toRgbNetwork(network: string): string {
  switch (network.toLowerCase()) {
    case 'mainnet':
    case 'bitcoin':
      return 'Mainnet'
    case 'testnet':
      return 'Testnet'
    case 'signet':
      return 'Signet'
    // Mutinynet is a custom signet.
    case 'signetcustom':
    case 'customsignet':
    case 'mutinynet':
      return 'SignetCustom'
    case 'regtest':
      return 'Regtest'
    default:
      // Never guess a chain for key and address derivation.
      throw new ProtocolError(
        `Unsupported RGB network '${network}' (expected mainnet, testnet, signet, signetcustom, or regtest)`,
        'RGB_L1',
        'CONFIG',
      )
  }
}

const REGTEST_NETWORK = { ...TEST_NETWORK, bech32: 'bcrt' }

function btcNetworkFor(rgbNetwork: string) {
  if (rgbNetwork === 'Mainnet') return NETWORK
  if (rgbNetwork === 'Regtest') return REGTEST_NETWORK
  return TEST_NETWORK
}

function parseOutpoint(outpoint: string): { txid: string; vout: number } {
  const [txid, vout] = outpoint.split(':')
  const index = Number(vout)
  if (!/^[0-9a-f]{64}$/i.test(txid ?? '') || !Number.isInteger(index) || index < 0) {
    throw new ProtocolError(`Invalid outpoint '${outpoint}'`, 'RGB_L1', 'INVALID_PARAMS')
  }
  return { txid, vout: index }
}

/** rgb-lib-wasm reports errors as strings: `"<Display prefix>: details"`. */
function wasmErrorStartsWith(err: unknown, prefix: string): boolean {
  const message = typeof err === 'string' ? err : (err as { message?: unknown })?.message
  return typeof message === 'string' && message.startsWith(prefix)
}

const U64_MAX = (1n << 64n) - 1n

/** rgb-lib-wasm refuses a send whose operation expires within this much of the invoice. */
const INVOICE_EXPIRATION_MARGIN_SECS = 600
const OPERATION_DURATION_SECS = 3600
const DEFAULT_RECEIVE_DURATION_SECS = 86_400
/** How long the script of a failed witness receive stays watched (7 days). */
const FAILED_WITNESS_RECEIVE_GRACE_SECS = 604_800
const VANILLA_SYNC_LOOKBACK = 20

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * HTLC locks need the PSBT-operation bindings of our rgb-lib-wasm fork, which
 * the proxy protocol 1.0 builds do not ship yet.
 */
function htlcUnsupported(): ProtocolError {
  return new ProtocolError(
    'HTLC swap locks are not available in this rgb-lib-wasm build',
    'RGB_L1',
    'NOT_SUPPORTED',
  )
}

/** The IRgbHtlcOperations methods that need the PSBT-operation bindings. */
const HTLC_METHODS = [
  'fundRgbHtlcLock',
  'acceptRgbHtlcLock',
  'rgbHtlcPayoutAddress',
  'prepareRgbHtlcSpend',
  'getRgbHtlcOperation',
  'listRgbHtlcOperationsSpending',
  'markRgbHtlcBroadcast',
  'applyRgbHtlcOperation',
  'provideRgbHtlcReceive',
  'abortRgbHtlcOperation',
] as const

/** The recipient fields a proxy protocol 1.0 send copies from the invoice. */
interface InvoiceRecipient {
  recipientId: string
  assetId: string | null
  transportEndpoints: string[]
  publicKey: string | null
  encryption: string | null
  expirationTimestamp: number | null
}

function toHtlcOperation(raw: any): RgbHtlcOperation {
  const allocations: RgbHtlcAllocation[] = (raw?.allocations ?? []).map((a: any) => {
    const fungible = a?.assignment?.Fungible
    return {
      assetId: String(a?.assetId ?? a?.asset_id ?? ''),
      vout: a?.vout == null ? null : Number(a.vout),
      amount: fungible == null ? null : Number(fungible),
    }
  })
  return {
    operationId: String(raw?.operationId ?? raw?.operation_id ?? ''),
    coloredPsbt: String(raw?.coloredPsbt ?? raw?.colored_psbt ?? ''),
    txid: String(raw?.txid ?? ''),
    status: String(raw?.status ?? 'prepared').toLowerCase() as RgbHtlcOperation['status'],
    broadcast: String(raw?.broadcast ?? 'not_attempted').toLowerCase() as RgbHtlcOperation['broadcast'],
    allocations,
  }
}

/**
 * Serialize every WasmWallet call: rgb-lib-wasm is single-threaded and corrupts
 * or panics on interleaved-async access. All methods become async.
 */
export function serializeWasmAccount<T extends object>(account: T): T {
  let chain: Promise<unknown> = Promise.resolve()
  return new Proxy(account, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const run = chain.then(() => (value as (...a: unknown[]) => unknown).apply(target, args))
        chain = run.then(
          () => undefined,
          () => undefined,
        )
        return run
      }
    },
  }) as T
}

export interface CreateRgbUtxosParams {
  num?: number
  size?: number
  feeRate?: number
  upTo?: boolean
  /** Aborts the preparation (sync and begin); a broadcast cannot be aborted. */
  signal?: AbortSignal
}

export interface SendBtcParams {
  address: string
  amount: number
  feeRate?: number
  signal?: AbortSignal
}

/** A required amount: a non-negative safe integer, never a silent zero. */
const sats = (v: unknown, field: string): number => {
  const n = typeof v === 'bigint' || typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ProtocolError(`PSBT inspection has an invalid ${field}`, 'RGB_L1', 'INVALID_RESPONSE')
  }
  return n
}

/** rgb-lib's PSBT inspection as plain numbers: its amounts reach JS as BigInt. */
export function toRgbPsbtSummary(raw: any): RgbPsbtSummary {
  if (!raw || !Array.isArray(raw.inputs) || !Array.isArray(raw.outputs)) {
    throw new ProtocolError('PSBT inspection has no inputs or outputs', 'RGB_L1', 'INVALID_RESPONSE')
  }
  return {
    txid: String(raw.txid ?? ''),
    inputs: raw.inputs.map((i: any) => ({
      outpoint: formatOutpoint(i?.outpoint),
      amountSat: sats(i?.amountSat, 'input amount'),
      isMine: Boolean(i?.isMine),
    })),
    outputs: raw.outputs.map((o: any) => ({
      address: o?.address ?? null,
      amountSat: sats(o?.amountSat, 'output amount'),
      isOpReturn: Boolean(o?.isOpReturn),
      isMine: Boolean(o?.isMine),
    })),
    totalInputSat: sats(raw.totalInputSat, 'input total'),
    totalOutputSat: sats(raw.totalOutputSat, 'output total'),
    feeSat: sats(raw.feeSat, 'fee'),
    sizeVbytes: sats(raw.sizeVbytes, 'size'),
    signatureCount: sats(raw.signatureCount, 'signature count'),
  }
}

export type SendAssetParams = {
  assetId?: string
  token: string
  recipientId?: string
  recipient: string
  /**
   * The recipient's RGB invoice. Proxy protocol 1.0 sends need its public key,
   * encryption preference and expiration, so a bare recipient id is refused.
   * `recipient`/`recipientId` may carry the invoice instead.
   */
  invoice?: string
  amount: number
  assignment?: { type?: string; value?: number } | null
  feeRate?: number
  minConfirmations?: number
  donation?: boolean
  /** Overrides the invoice's transport endpoints. */
  transportEndpoints?: string[]
  /** Set only for witness invoices (blinded otherwise). */
  witnessData?: { amountSat?: number; amount_sat?: number; blinding?: number | null } | null
  witness_data?: { amountSat?: number; amount_sat?: number; blinding?: number | null } | null
  /** Aborts the preparation (sync and begin); a broadcast send cannot be aborted. */
  signal?: AbortSignal
}

export class RgbLibWasmAdapter
  extends BaseWdkAdapter
  implements IProtocolAdapter, IRgbHtlcOperations, IRgbPreviewOperations
{
  readonly protocolName: ProtocolType = 'RGB_L1'
  readonly capabilities = PROTOCOL_OPERATIONS.RGB_L1
  readonly supportedLayers: Layer[] = getCapabilities('RGB_L1').layers
  override readonly version = '0.1.0-wasm'

  /** The rgb-lib `online` handle returned by goOnline(); required by network ops. */
  private online: any = null
  private transportEndpoints: string[] = []
  private wasmModule: any = null
  private rgbNetwork = 'Mainnet'

  // --- Connection ---------------------------------------------------------
  async connect(config: BaseProtocolConfig): Promise<void> {
    const cfg = config as RgbLibWasmAdapterConfig
    if (!cfg.mnemonic) throw new ProtocolError('RgbLibWasmAdapter requires a mnemonic', 'RGB_L1', 'CONFIG')
    if (!cfg.indexerUrl) throw new ProtocolError('RgbLibWasmAdapter requires an indexerUrl', 'RGB_L1', 'CONFIG')
    await this.releasePreviousConnection()
    this.network = cfg.network ?? 'mainnet'
    this.transportEndpoints = cfg.transportEndpoints ?? []
    const rgbNetwork = toRgbNetwork(this.network)
    this.rgbNetwork = rgbNetwork

    // The host injects an already-wasm-initialized module; the inline import is
    // the Node/Vite fallback. `init()` is rgb-lib's panic/log hook (idempotent).
    // @ts-ignore — declared as an optional dep; resolved at runtime.
    const mod = await loadWdkModule('@utexo/rgb-lib-wasm', () => import('@utexo/rgb-lib-wasm'))
    try {
      mod.init?.()
    } catch {
      /* already initialized */
    }

    this.wasmModule = mod
    // Taproot keeps the account keys, and so the addresses, of existing wallets.
    const keys = mod.restoreKeys(rgbNetwork, cfg.mnemonic, 'Taproot')
    const walletData = {
      // Scope the store by rgb-lib network, not the host label: rgb-lib panics
      // ("unreachable") if a store is reopened under a different BitcoinNetwork.
      dataDir: cfg.dataDir ?? `rgb-l1-${rgbNetwork.toLowerCase()}`,
      bitcoinNetwork: rgbNetwork,
      databaseType: 'Sqlite', // the enum value the wasm build accepts; IndexedDB is the actual backing
      maxAllocationsPerUtxo: cfg.maxAllocationsPerUtxo ?? 5,
      // rgb-lib rejects the IFA and BFA schemas on mainnet (CannotUseSchemaOnMainnet),
      // which makes WasmWallet.create throw.
      supportedSchemas: rgbNetwork === 'Mainnet' ? ['Nia'] : ['Nia', 'Ifa', 'Bfa'],
    }
    const walletKeys = {
      accountXpubVanilla: keys.accountXpubVanilla,
      accountXpubColored: keys.accountXpubColored,
      masterFingerprint: keys.masterFingerprint,
      witnessVersion: keys.witnessVersion,
      mnemonic: keys.mnemonic ?? cfg.mnemonic,
      vanillaKeychain: null,
    }

    const WasmWallet = mod.WasmWallet
    const rawWallet = await WasmWallet.create(JSON.stringify(walletData), JSON.stringify(walletKeys))
    // Not reentrant: an op starting mid-flight corrupts thread-locals and panics
    // ("Lazy instance poisoned"). Queue every wallet call so they never overlap.
    this.account = serializeWasmAccount(rawWallet)
    this.exposeHtlcOperations(typeof rawWallet.psbtOpPrepare === 'function')
    const skipConsistencyCheck = cfg.skipConsistencyCheck ?? false
    const goOnline = (evmChains: Record<string, unknown>) =>
      this.account.goOnline({
        indexerConfig: { Esplora: { url: cfg.indexerUrl } },
        skipConsistencyCheck,
        failedWitnessReceiveGraceSecs: FAILED_WITNESS_RECEIVE_GRACE_SECS,
        vanillaSyncLookback: VANILLA_SYNC_LOOKBACK,
        proxyAuthKeys: {},
        evmChains,
      })
    const evmChains = rgbNetwork === 'Mainnet' ? {} : toRgbLibEvmChains(cfg.evmChains)
    try {
      try {
        this.online = await goOnline(evmChains)
      } catch (e) {
        if (!Object.keys(evmChains).length || !isEvmChainError(e)) throw e
        // BFA mints wait for the chain; the rest of the wallet must not
        // the error can carry the RPC URL, which may hold an API key
        console.warn('[RGB-L1] EVM chains unusable, going online without them:', Object.keys(evmChains).join(', '))
        this.online = await goOnline({})
      }
    } catch (e) {
      // The store disagrees with the chain: surface it instead of trading on it.
      if (wasmErrorStartsWith(e, 'Data is inconsistent')) {
        throw new ProtocolError(`RGB wallet state is inconsistent: ${errorMessage(e)}`, 'RGB_L1', 'INCONSISTENT')
      }
      throw e
    }
    this.connected = true
    // The consistency check already ran a full scan.
    if (skipConsistencyCheck) await this.recoverBtcStateIfThin()
  }

  /**
   * One-time recovery for a wallet restored from a thin BDK snapshot (no revealed
   * SPKs), left behind when an MV3 teardown interrupts rgb-lib-wasm's async save.
   * Incremental sync can't rediscover the on-chain BTC there, so balance reads 0:
   * if BTC is still 0 after a sync, a full scan then `flush`. Best-effort.
   */
  private async recoverBtcStateIfThin(): Promise<void> {
    try {
      await this.syncWallet()
      const { total } = await this.getBtcBalance()
      if (total > 0) return // state already healthy — skip the costlier full scan
      await this.syncWallet('FullScan')
      await this.flushState()
    } catch (e) {
      console.error('[RGB-L1] BTC state recovery scan failed:', e)
    }
  }

  /** Sync both keychains; rgb-lib-wasm syncs one keychain per call. */
  private async syncWallet(
    strategy: 'FastSync' | 'FullSync' | 'FullScan' = 'FastSync',
    signal?: AbortSignal,
  ): Promise<void> {
    await this.account.sync(this.online, { keychain: 'Colored', strategy }, signal ?? null)
    await this.account.sync(
      this.online,
      { keychain: { Vanilla: { lookback: VANILLA_SYNC_LOOKBACK } }, strategy },
      signal ?? null,
    )
  }

  async getConnectionInfo(): Promise<ConnectionInfo> {
    this.assertConnected()
    return { protocol: 'RGB_L1', connected: this.connected, network: this.network }
  }

  // --- Address / receive --------------------------------------------------
  async getReceiveAddress(assetId?: string): Promise<Address> {
    this.assertConnected()
    // Only a real RGB asset id (rgb:…) yields a blinded invoice; BTC / "BTC" /
    // empty must return the on-chain BTC address (otherwise the BTC tab shows an
    // empty "bitcoin:" QR).
    if (assetId && assetId.startsWith('rgb:')) {
      const inv = await this.receiveRgb({ assetId })
      return { address: inv?.invoice ?? inv?.recipient_id ?? '', format: 'RGB_INVOICE', asset: assetId }
    }
    const address: string = await this.account.getAddress()
    return { address, format: 'BTC_ADDRESS' }
  }

  // --- Balance ------------------------------------------------------------
  /** Raw vanilla / colored BTC split as rgb-lib reports it (both in sats). */
  private async detailedBtcBalance(): Promise<{
    vanilla: { settled: number; future: number; spendable: number }
    colored: { settled: number; future: number; spendable: number }
  }> {
    this.assertConnected()
    const v: any = (await this.account.getBtcBalance(this.online, true)) ?? {}
    return {
      vanilla: readRgbLibBtcBalanceBucket(v.vanilla ?? v),
      colored: v.colored ? readRgbLibBtcBalanceBucket(v.colored) : { settled: 0, spendable: 0, future: 0 },
    }
  }

  async getBtcBalance(): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    const { vanilla } = await this.detailedBtcBalance()
    // Colored sats carry RGB allocations; spending them as ordinary BTC destroys
    // the bound asset. They remain visible via getRgbDetailedBalance(), not here.
    const settled = vanilla.settled
    const spendable = vanilla.spendable
    const future = vanilla.future
    return { confirmed: settled, unconfirmed: Math.max(0, future - settled), total: spendable }
  }

  /** Detailed BTC balance with the vanilla / colored split (IProtocolAdapter hook). */
  async getRgbDetailedBalance(): Promise<{
    vanilla: { settled: number; future: number; spendable: number }
    colored: { settled: number; future: number; spendable: number }
  }> {
    return this.detailedBtcBalance()
  }

  async refreshBalances(opts: { signal?: AbortSignal } = {}): Promise<void> {
    this.assertConnected()
    // Sync the wallet ONCE, then refresh transfer statuses reusing that sync
    // (skip_sync=true). Previously refresh(skip_sync=false) synced and then we
    // synced again — two full indexer round-trips, ~2× the cold-sync wait.
    await this.syncWallet('FastSync', opts.signal)
    const result = await this.account.refresh?.(this.online, null, [], true, opts.signal ?? null)
    // rgb-lib reports a transfer it cannot advance as a per-transfer `failure`,
    // not a throw; unlogged, a receive that never settles leaves no trace (#108).
    for (const [idx, t] of refreshEntries(result)) {
      if (t?.failure != null) {
        console.warn(`[RGB-L1] refresh could not advance transfer batch ${idx}:`, describeRgbLibError(t.failure))
      }
    }
    // Flush or the settled-transfer promotion lives only in memory and is lost
    // on the next MV3 cold start, resurfacing as stale balances on the next send.
    await this.flushState()
  }

  async listAssets(): Promise<UnifiedAsset[]> {
    this.assertConnected()
    const { total } = await this.getBtcBalance()
    const out: UnifiedAsset[] = [rgbBtcAsset(total, RGB_L1_PROFILE)]
    const res: any = await this.account.listAssets([])
    // Fungible schemas rgb-lib-wasm supports: NIA, IFA and BFA (no CFA).
    // rgbNiaAsset maps each fungible shape.
    const assets = fungibleAssets(res)
    for (const a of assets) out.push(rgbNiaAsset(normalizeAsset(a), RGB_L1_PROFILE))
    return out
  }

  async getAssetBalance(assetId: string): Promise<UnifiedAsset['balance']> {
    this.assertConnected()
    try {
      const raw: any = await this.account.getAssetBalance(assetId)
      const precision = (await this.listAssets()).find((x) => x.id === assetId)?.precision ?? 0
      return rgbAssetBalance(raw, precision)
    } catch {
      const a = (await this.listAssets()).find((x) => x.id === assetId)
      return a?.balance ?? rgbAssetBalance({})
    }
  }

  async getAsset(assetId: string): Promise<UnifiedAsset> {
    const found = (await this.listAssets()).find((a) => a.id === assetId)
    if (!found) throw new ProtocolError(`Unknown asset ${assetId}`, 'RGB_L1', 'NO_ASSET')
    return found
  }

  /**
   * Issue a NIA (fungible) asset and return it in the same shape listAssets()
   * yields. rgb-lib-wasm exposes issuance only on the wallet handle and returns
   * a plain serde object, but a host that forwards the call without awaiting it
   * (or reads it back through a structured clone) sees `{}` and reports a
   * hollow success. Awaiting here, requiring an asset id, and carrying the
   * issuance fields into `metadata` is what keeps that from reaching callers.
   *
   * Not part of IProtocolAdapter: only the wasm backing can issue, and only
   * when the resolved rgb-lib build ships the binding. Callers feature-detect
   * with `typeof adapter.issueAssetNia === 'function'` and fail closed, the
   * same way the Liquid adapter derives its Simplicity operations.
   */
  async issueAssetNia(params: {
    ticker: string
    name: string
    precision?: number
    amounts: number[]
  }): Promise<UnifiedAsset> {
    this.assertConnected()
    const wallet = this.account as unknown as {
      issueAssetNia?: (
        ticker: string,
        name: string,
        precision: number,
        amounts: number[]
      ) => unknown
    }
    if (typeof wallet?.issueAssetNia !== 'function') {
      throw new ProtocolError(
        'NIA issuance is not available in this rgb-lib-wasm build',
        'RGB_L1',
        'NOT_SUPPORTED'
      )
    }
    if (!Array.isArray(params.amounts) || params.amounts.length === 0) {
      throw new ProtocolError('At least one issuance amount is required', 'RGB_L1', 'BAD_REQUEST')
    }
    // Amounts cross into wasm as u64: anything but a positive safe integer would
    // be silently truncated or rejected with an opaque binding error.
    const amounts = params.amounts.map(Number)
    if (!amounts.every((n) => Number.isSafeInteger(n) && n > 0)) {
      throw new ProtocolError(
        'Issuance amounts must be positive safe integers',
        'RGB_L1',
        'BAD_REQUEST',
        { amounts: params.amounts }
      )
    }

    let issued: unknown
    try {
      issued = await wallet.issueAssetNia(params.ticker, params.name, Number(params.precision ?? 0), amounts)
    } catch (e) {
      // rgb-lib-wasm throws bare strings; give hosts a stable code to match on.
      const msg = e instanceof Error ? e.message : String(e)
      throw new ProtocolError(`NIA issuance failed: ${msg}`, 'RGB_L1', 'ISSUANCE_FAILED', { message: msg })
    }
    // Issuance mutates RGB state, which cannot be rebuilt from the seed.
    await this.flushState()

    const plain = plainFromWasm(issued)
    const normalized = normalizeAsset(plain)
    if (!normalized.asset_id) {
      throw new ProtocolError(
        'NIA issuance returned no asset id — the wallet may have no colorable UTXO',
        'RGB_L1',
        'ISSUANCE_FAILED'
      )
    }
    const asset = rgbNiaAsset(normalized, RGB_L1_PROFILE)
    const metadata = normalizeIssuanceMetadata(plain)
    if (Object.keys(metadata).length > 0) asset.metadata = metadata
    return asset
  }

  // --- Invoices -----------------------------------------------------------
  async createInvoice(request: InvoiceRequest): Promise<Invoice> {
    this.assertConnected()
    if (!request.asset || request.asset === 'BTC') {
      throw new ProtocolError('RGB-L1 has no Lightning invoices; use getReceiveAddress for BTC', 'RGB_L1', 'NOT_SUPPORTED')
    }
    const inv: any = await this.receiveRgb({
      assetId: request.asset,
      amount: request.assetAmount,
      durationSeconds: request.expirySeconds,
    })
    return {
      invoice: inv?.invoice ?? '',
      paymentHash: inv?.recipientId ?? inv?.recipient_id ?? '',
      amount: request.assetAmount,
      expiresAt: inv?.expirationTimestamp ? inv.expirationTimestamp * 1000 : Date.now() + (request.expirySeconds ?? 3600) * 1000,
      description: request.description,
    }
  }

  async decodeInvoice(_invoice: string): Promise<DecodedInvoice> {
    throw new ProtocolError('RGB-L1 adapter does not decode invoices', 'RGB_L1', 'NOT_SUPPORTED')
  }

  // --- Send (Lightning not supported) -------------------------------------
  async sendPayment(_request: PaymentRequest): Promise<PaymentResult> {
    throw new ProtocolError('RGB-L1 has no Lightning send; use sendAsset or sendBtcOnchain', 'RGB_L1', 'NOT_SUPPORTED')
  }

  async getPaymentStatus(_paymentHash: string): Promise<PaymentStatus> {
    throw new ProtocolError('RGB-L1 has no Lightning payment status', 'RGB_L1', 'NOT_SUPPORTED')
  }

  // --- Transactions -------------------------------------------------------
  async listTransactions(filter?: TransactionFilter): Promise<UnifiedTransaction[]> {
    this.assertConnected()
    const raw: any = await this.account.listTransactions(this.online, true)
    const txs: any[] = Array.isArray(raw) ? raw : raw?.transactions ?? []
    const mapped = txs.map((t) => {
      const { received, sent, type } = normalizeRgbLibTransactionAmounts(t)
      const confTime = t.confirmationTime ?? t.confirmation_time
      const timestampSeconds = normalizeRgbLibTimestamp(confTime)
      return {
        id: t.txid ?? t.transactionId ?? t.transaction_id ?? '',
        type,
        status: (timestampSeconds ? 'confirmed' : 'pending') as TransactionStatus,
        timestamp: timestampSeconds * 1000,
        amount: Math.abs(received - sent) || received || sent,
        amountDisplay: '',
        asset: rgbBtcAsset(0, RGB_L1_PROFILE),
        protocolData: {
          ...t,
          transactionType: normalizeRgbLibTxType(t.transactionType ?? t.transaction_type),
        },
      }
    })
    // Apply the TransactionFilter the signature accepts: predicates, then a
    // newest-first order, then offset/limit (audit finding G-F8).
    return applyTransactionFilter(mapped, filter)
  }

  async getTransaction(txId: string): Promise<UnifiedTransaction> {
    const found = (await this.listTransactions()).find((t) => t.id === txId)
    if (!found) throw new ProtocolError(`Unknown tx ${txId}`, 'RGB_L1', 'NO_TX')
    return found
  }

  async getNodeInfo(): Promise<NodeInfo> {
    return {}
  }

  async listChannels(): Promise<unknown[]> {
    // Distinguish an unsupported channel model from an unavailable wallet.
    this.assertConnected()
    return []
  }

  async listPayments(): Promise<unknown> {
    this.assertConnected()
    return []
  }

  async listTransfers(options?: { asset_id?: string }): Promise<unknown> {
    this.assertConnected()
    if (options?.asset_id) return this.account.listTransfers({ Id: options.asset_id }, 'All')
    return this.listAllTransfers()
  }

  /**
   * Every transfer the wallet knows, each tagged with its asset id: rgb-lib's
   * transfer rows carry none, so list per asset, then the ones with no asset.
   */
  private async listAllTransfers(): Promise<any[]> {
    const rows = (raw: any): any[] => (Array.isArray(raw) ? raw : raw?.transfers ?? [])
    const res: any = await this.account.listAssets([])
    const assets = fungibleAssets(res)
    const out: any[] = []
    for (const a of assets) {
      const assetId = normalizeAsset(a).asset_id
      if (!assetId) continue
      for (const t of rows(await this.account.listTransfers({ Id: assetId }, 'All'))) {
        out.push({ ...t, assetId: t?.assetId ?? t?.asset_id ?? assetId })
      }
    }
    out.push(...rows(await this.account.listTransfers('None', 'All')))
    return out
  }

  // --- RGB-specific hooks (used by the RGB host surface) ------------------
  async createRgbInvoice(params: {
    assetId?: string
    amount?: number
    durationSeconds?: number
    minConfirmations?: number
    /** false ⇒ blinded receive (private, default); true ⇒ witness receive. */
    witness?: boolean
    /** Host-supplied assignment, e.g. { type: 'Fungible', value: 100 }. */
    assignment?: { type?: string; value?: number } | null
  }): Promise<any> {
    this.assertConnected()
    return this.receiveRgb(params)
  }

  /**
   * Generate an RGB receive invoice — blinded by default; `witness: true` makes the
   * sender create the UTXO. rgb-lib's `Assignment` is `{ Fungible: <num> }` or the
   * string `"Any"` — not null, not bigint.
   */
  private async receiveRgb(opts: {
    assetId?: string | null
    amount?: number
    assignment?: { type?: string; value?: number } | null
    durationSeconds?: number | null
    minConfirmations?: number
    witness?: boolean
  }): Promise<any> {
    const fungibleValue =
      opts.amount != null
        ? opts.amount
        : opts.assignment?.type === 'Fungible' && opts.assignment.value != null
          ? opts.assignment.value
          : undefined
    const assignment = fungibleValue != null ? { Fungible: Number(fungibleValue) } : 'Any'
    // rgb-lib takes an absolute expiration and reserves the invoice on the proxy.
    const expirationTimestamp = nowSeconds() + (opts.durationSeconds ?? DEFAULT_RECEIVE_DURATION_SECS)
    const args = [
      this.online,
      opts.assetId ?? null,
      assignment,
      expirationTimestamp,
      this.transportEndpoints,
      opts.minConfirmations ?? 1,
      null,
    ] as const
    const res: any = await (opts.witness
      ? this.account.witnessReceive(...args)
      : this.account.blindReceive(...args))
    // Generating an invoice records a pending transfer in the wallet DB; flush so
    // it survives a service-worker restart before the payer pays it.
    await this.flushState()
    // Normalize to a plain, structured-clone-safe object: the wasm result can
    // carry BigInt / wasm-bound values that break chrome message passing
    // ("could not serialize message"). Coerce the fields the host reads.
    return {
      invoice: res?.invoice ?? '',
      recipientId: res?.recipientId ?? res?.recipient_id ?? '',
      recipient_id: res?.recipientId ?? res?.recipient_id ?? '',
      expirationTimestamp:
        res?.expirationTimestamp != null ? Number(res.expirationTimestamp) : undefined,
      batchTransferIdx:
        res?.batchTransferIdx != null ? Number(res.batchTransferIdx) : undefined,
      publicKey: res?.publicKey ?? res?.public_key ?? undefined,
    }
  }

  async signPsbt(psbtHex: string): Promise<{ psbt: string; unchanged: boolean }> {
    this.assertConnected()
    const signed: string = await this.account.signPsbt(psbtHex)
    return { psbt: signed ?? psbtHex, unchanged: !signed || signed === psbtHex }
  }

  // --- HTLC spends ----------------------------------------------------------
  // RGB locked in a swap HTLC belongs to no wallet key, so the swap client
  // builds the spend and this wallet colors it. Each step is recorded by
  // rgb-lib before it resolves, so a restart resumes from the operation.

  async fundRgbHtlcLock(params: {
    assetId: string
    amount: number
    recipientId: string
    blinding: string
    htlcSat: number
    transportEndpoints?: string[]
    minConfirmations?: number
    feeRate?: number
  }): Promise<{ txid: string }> {
    this.assertConnected()
    this.requireHtlcBinding('psbtOpPrepare')
    if (!params.assetId || !params.recipientId) {
      throw new ProtocolError('HTLC lock needs an asset id and a recipient id', 'RGB_L1', 'INVALID_PARAMS')
    }
    if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
      throw new ProtocolError('HTLC lock amount must be a positive integer', 'RGB_L1', 'INVALID_PARAMS')
    }
    if (!Number.isSafeInteger(params.htlcSat) || params.htlcSat <= 0) {
      throw new ProtocolError('HTLC output sats must be a positive integer', 'RGB_L1', 'INVALID_PARAMS')
    }
    // The maker seals to this exact u64; a JS number would round it above 2^53.
    if (!/^\d{1,20}$/.test(params.blinding) || BigInt(params.blinding) > U64_MAX) {
      throw new ProtocolError('HTLC lock blinding must be a u64 decimal string', 'RGB_L1', 'INVALID_PARAMS')
    }
    const transportEndpoints =
      params.transportEndpoints && params.transportEndpoints.length > 0
        ? params.transportEndpoints
        : this.transportEndpoints
    const sat = String(params.htlcSat)
    const witnessData = { amountSat: sat, amount_sat: sat, blinding: params.blinding }
    const recipient = {
      recipientId: params.recipientId,
      recipient_id: params.recipientId,
      assignment: { Fungible: params.amount },
      witnessData,
      witness_data: witnessData,
      transportEndpoints,
      transport_endpoints: transportEndpoints,
    }
    const result = await this.sendRecipients({ [params.assetId]: [recipient] }, {
      feeRate: params.feeRate,
      minConfirmations: params.minConfirmations,
    })
    const txid = typeof result?.txid === 'string' ? result.txid : ''
    if (!txid) throw new ProtocolError('HTLC lock send returned no txid', 'RGB_L1', 'SEND_ERROR')
    return { txid }
  }

  async acceptRgbHtlcLock(params: {
    recipientId: string
    consignmentEndpoint: string
    blinding: string
    minConfirmations: number
    assetId: string
    amount: number
    lockTxid: string
  }): Promise<{ status: 'accepted' | 'awaitingConfirmations' }> {
    this.assertConnected()
    this.requireHtlcBinding('fetchAndAcceptTransferByRecipientId')
    if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
      throw new ProtocolError('HTLC lock amount must be a positive integer', 'RGB_L1', 'INVALID_PARAMS')
    }
    let accepted: any
    try {
      accepted = await this.account.fetchAndAcceptTransferByRecipientId(
        this.online,
        params.recipientId,
        params.recipientId,
        params.consignmentEndpoint,
        params.blinding,
        params.minConfirmations,
        { assetId: params.assetId, assetSchema: 'Nia', assignment: { Fungible: params.amount } },
      )
    } catch (e) {
      if (wasmErrorStartsWith(e, 'Insufficient confirmations')) return { status: 'awaitingConfirmations' }
      throw e
    }
    const assignments: any[] = accepted?.assignments ?? []
    if (assignments.length !== 1 || Number(assignments[0]?.Fungible) !== params.amount) {
      throw new ProtocolError(
        `HTLC lock assigns ${JSON.stringify(assignments)}, expected ${params.amount}`,
        'RGB_L1',
        'INVALID_PARAMS',
      )
    }
    await this.account.saveNewAsset(this.online, accepted.consignment, params.lockTxid)
    await this.flushState()
    return { status: 'accepted' }
  }

  async rgbHtlcPayoutAddress(params?: { assetId?: string }): Promise<{ address: string; recipientId: string }> {
    this.assertConnected()
    if (typeof this.wasmModule?.scriptBufFromRecipientId !== 'function') throw htlcUnsupported()
    if (this.transportEndpoints.length === 0) {
      // rgb-lib-wasm settles the payout receive through its transport endpoint.
      throw new ProtocolError('An HTLC payout needs a transport endpoint', 'RGB_L1', 'CONFIG')
    }
    const receive = await this.receiveRgb({ assetId: params?.assetId ?? null, witness: true, minConfirmations: 1 })
    const scriptHex: string | null = this.wasmModule.scriptBufFromRecipientId(receive.recipientId)
    if (!scriptHex) throw new ProtocolError('Witness receive returned no script', 'RGB_L1', 'INTERNAL')
    const address = BtcAddress(btcNetworkFor(this.rgbNetwork)).encode(OutScript.decode(hex.decode(scriptHex)))
    return { address, recipientId: receive.recipientId }
  }

  async prepareRgbHtlcSpend(params: {
    psbt: string
    assetId: string
    outputIndex: number
    amount: number
    inputOutpoints: string[]
  }): Promise<RgbHtlcOperation> {
    this.assertConnected()
    this.requireHtlcBinding('psbtOpPrepare')
    if (!Number.isSafeInteger(params.amount) || params.amount <= 0) {
      throw new ProtocolError('HTLC spend amount must be a positive integer', 'RGB_L1', 'INVALID_PARAMS')
    }
    if (params.inputOutpoints.length === 0) {
      throw new ProtocolError('An HTLC spend needs at least one input', 'RGB_L1', 'INVALID_PARAMS')
    }
    const raw = await this.account.psbtOpPrepare(
      params.psbt,
      { assetInfoMap: { [params.assetId]: { outputMap: { [params.outputIndex]: params.amount } } } },
      params.inputOutpoints.map(parseOutpoint),
      1,
      'never',
    )
    const operation = toHtlcOperation({ status: 'prepared', ...raw })
    if (!operation.txid) {
      // psbtOpPrepare does not return the txid; the stored operation does.
      // (Parsing the colored PSBT locally fails: rgb-lib sets PSBTv2 global
      // fields on a v0 PSBT, which strict parsers refuse.)
      const recorded = (await this.listRgbHtlcOperationsSpending(params.inputOutpoints[0])).find(
        (op) => op.operationId === operation.operationId,
      )
      if (!recorded?.txid) {
        throw new ProtocolError('rgb-lib recorded no txid for the HTLC spend', 'RGB_L1', 'INTERNAL')
      }
      operation.txid = recorded.txid
    }
    return operation
  }

  async getRgbHtlcOperation(txid: string): Promise<RgbHtlcOperation | null> {
    this.assertConnected()
    this.requireHtlcBinding('psbtOpByTxid')
    try {
      return toHtlcOperation(await this.account.psbtOpByTxid(txid))
    } catch (e) {
      if (wasmErrorStartsWith(e, 'HTLC operation not found')) return null
      throw e
    }
  }

  async listRgbHtlcOperationsSpending(outpoint: string): Promise<RgbHtlcOperation[]> {
    this.assertConnected()
    this.requireHtlcBinding('psbtOpsSpending')
    const raw: any[] = (await this.account.psbtOpsSpending(parseOutpoint(outpoint))) ?? []
    return raw.map(toHtlcOperation)
  }

  async markRgbHtlcBroadcast(operationId: string): Promise<void> {
    this.assertConnected()
    this.requireHtlcBinding('psbtOpMarkBroadcast')
    await this.account.psbtOpMarkBroadcast(operationId)
  }

  async applyRgbHtlcOperation(operationId: string): Promise<void> {
    this.assertConnected()
    this.requireHtlcBinding('psbtOpApply')
    await this.account.psbtOpApply(this.online, operationId)
    await this.flushState()
  }

  async provideRgbHtlcReceive(params: { operationId: string; assetId: string; txid: string }): Promise<{
    status: 'provided' | 'alreadyProvided'
  }> {
    this.assertConnected()
    this.requireHtlcBinding('psbtOpProvideReceiveConsignment')
    try {
      await this.account.psbtOpProvideReceiveConsignment(this.online, params.operationId, params.assetId)
    } catch (e) {
      // Repeating a handover that already happened is refused; the receive of
      // that txid having moved past waiting-for-consignment is the proof.
      if (wasmErrorStartsWith(e, 'Cannot provide out-of-band consignment') && (await this.receivedHtlcPayout(params))) {
        return { status: 'alreadyProvided' }
      }
      throw e
    }
    await this.flushState()
    return { status: 'provided' }
  }

  private async receivedHtlcPayout(params: { assetId: string; txid: string }): Promise<boolean> {
    const raw: any = await this.account.listTransfers({ Id: params.assetId }, 'All')
    const rows: any[] = Array.isArray(raw) ? raw : (raw?.transfers ?? [])
    return rows.some((t) => {
      const kind = String(t?.kind ?? '')
      const status = String(t?.status ?? '')
      return (
        t?.txid === params.txid &&
        kind.startsWith('Receive') &&
        (status === 'WaitingConfirmations' || status === 'Settled')
      )
    })
  }

  async abortRgbHtlcOperation(operationId: string): Promise<void> {
    this.assertConnected()
    this.requireHtlcBinding('psbtOpAbort')
    await this.account.psbtOpAbort(this.online, operationId)
    await this.flushState()
  }

  /**
   * Hide the HTLC methods on a build without their bindings, so capability
   * probes (`asRgbHtlcOperations`, a host's method check) report them missing.
   */
  /**
   * The BFA mint received on `recipientId` once rgb-lib has checked it: its
   * transfer waits for the lock on the bridge's EVM chain until it settles.
   * Null when no checked mint pays it, or the binding lacks the call.
   */
  async getReceivedMint(recipientId: string): Promise<RgbReceivedMint | null> {
    this.assertConnected()
    const get = (this.account as { getReceivedMint?: (id: string) => unknown } | null)?.getReceivedMint
    if (typeof get !== 'function') return null
    const raw: any = await get.call(this.account, recipientId)
    if (!raw) return null
    const text = (v: unknown) => (v == null ? '' : String(v))
    return {
      lockId: text(raw.lockId ?? raw.lock_id),
      amount: text(raw.amount),
      beforeBlock: text(raw.beforeBlock ?? raw.before_block),
      evmChainId: text(raw.evmChainId ?? raw.evm_chain_id),
      bridgeContract: text(raw.bridgeContract ?? raw.bridge_contract),
    }
  }

  private exposeHtlcOperations(available: boolean): void {
    for (const name of HTLC_METHODS) {
      if (available) delete (this as Record<string, unknown>)[name]
      else Object.defineProperty(this, name, { value: undefined, configurable: true, writable: true })
    }
  }

  private requireHtlcBinding(name: string): void {
    if (typeof (this.account as Record<string, unknown> | null)?.[name] !== 'function') throw htlcUnsupported()
  }

  async finalizeRgbPsbt(psbt: string): Promise<string> {
    this.assertConnected()
    return this.account.finalizePsbt(psbt)
  }

  async createRgbUtxos(params: CreateRgbUtxosParams): Promise<{ success: boolean }> {
    await this.endVanilla(
      () => this.beginCreateUtxos(params, false),
      (signed) => this.account.createUtxosEnd(this.online, signed),
    )
    // Commit the new UTXO set before the caller relies on it (e.g. immediately
    // issuing/receiving against the freshly-created colorable UTXOs).
    await this.flushState()
    return { success: true }
  }

  /** The PSBT creating the UTXOs would sign, with its exact fee; nothing is reserved. */
  async previewCreateRgbUtxos(params: CreateRgbUtxosParams): Promise<RgbPsbtSummary> {
    return this.inspectRgbPsbt(await this.beginCreateUtxos(params, true))
  }

  private async beginCreateUtxos(params: CreateRgbUtxosParams, dryRun: boolean): Promise<string> {
    this.assertConnected()
    // createUtxosBegin selects from vanilla UTXOs tracked in the local DB; sync
    // first so the indexer's current view is used.
    await this.refreshBalances({ signal: params.signal })
    const feeRate = BigInt(Math.round(params.feeRate ?? defaultRgbFeeRate(this.network)))
    return this.account.createUtxosBegin(
      this.online,
      params.upTo ?? false,
      false,
      params.num ?? null,
      params.size ?? null,
      feeRate,
      false,
      dryRun,
      params.signal ?? null,
    )
  }

  private prepareSendAsset(params: SendAssetParams): {
    recipientMap: Record<string, Record<string, unknown>[]>
    opts: { feeRate?: number; minConfirmations?: number; donation?: boolean }
  } {
    this.assertConnected()
    const amount = Number(params.amount ?? params.assignment?.value ?? 0)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ProtocolError('RGB-L1 asset send requires a positive amount', 'RGB_L1', 'INVALID_REQUEST')
    }
    const invoice = [params.invoice, params.recipient, params.recipientId].find(isRgbInvoice)
    if (!invoice) {
      throw new ProtocolError(
        "RGB-L1 asset send requires the recipient's invoice, not just its recipient id",
        'RGB_L1',
        'INVALID_REQUEST',
      )
    }
    const target = this.parseInvoiceRecipient(invoice)
    // A recipient id given next to the invoice is what the caller approved:
    // it must be the one the invoice pays.
    for (const named of [params.recipient, params.recipientId]) {
      if (named && !isRgbInvoice(named) && named !== target.recipientId) {
        throw new ProtocolError(
          `Invoice pays ${target.recipientId}, not ${named}`,
          'RGB_L1',
          'INVALID_REQUEST',
        )
      }
    }
    const token = params.token ?? params.assetId ?? target.assetId
    if (!token) throw new ProtocolError('RGB-L1 asset send requires an asset id', 'RGB_L1', 'INVALID_REQUEST')
    if (target.assetId && target.assetId !== token) {
      throw new ProtocolError(
        `Invoice is for asset ${target.assetId}, not ${token}`,
        'RGB_L1',
        'INVALID_REQUEST',
      )
    }
    const transportEndpoints =
      Array.isArray(params.transportEndpoints) && params.transportEndpoints.length > 0
        ? params.transportEndpoints
        : target.transportEndpoints
    const recipient: Record<string, unknown> = {
      recipientId: target.recipientId,
      assignment: toRgbLibAssignment(params.assignment, amount),
      transportEndpoints,
      publicKey: target.publicKey,
      encryption: target.encryption ?? 'Required',
      expirationTimestamp: target.expirationTimestamp,
    }
    const wd = params.witnessData ?? params.witness_data
    if (wd) {
      // Proxy protocol 1.0 derives a witness seal's blinding from both parties' keys.
      if (wd.blinding != null) {
        throw new ProtocolError('A witness send cannot choose its blinding', 'RGB_L1', 'INVALID_REQUEST')
      }
      // rgb-lib-wasm deserializes witness amounts through serde_json::Number,
      // which rejects integer-valued JS numbers; a decimal string is exact.
      recipient.witnessData = {
        amountSat: String(Math.round(Number(wd.amountSat ?? wd.amount_sat ?? 0))),
        blinding: null,
      }
    }
    return {
      recipientMap: { [token]: [recipient] },
      opts: { feeRate: params.feeRate, minConfirmations: params.minConfirmations, donation: params.donation },
    }
  }

  async sendAsset(params: SendAssetParams): Promise<any> {
    const { recipientMap, opts } = this.prepareSendAsset(params)
    return this.sendRecipients(recipientMap, { ...opts, signal: params.signal })
  }

  /** The PSBT a send would sign, with its exact fee; nothing is saved or broadcast. */
  async previewSendAsset(params: SendAssetParams): Promise<RgbPsbtSummary> {
    const { recipientMap, opts } = this.prepareSendAsset(params)
    return this.sendRecipients(recipientMap, { ...opts, signal: params.signal, dryRun: true })
  }

  private parseInvoiceRecipient(invoice: string): InvoiceRecipient {
    let data: any
    try {
      data = new this.wasmModule.WasmInvoice(invoice).invoiceData()
    } catch (e) {
      throw new ProtocolError(`Invalid RGB invoice: ${errorMessage(e)}`, 'RGB_L1', 'INVALID_REQUEST')
    }
    const recipientId = data?.recipientId ?? data?.recipient_id
    if (!recipientId) throw new ProtocolError('RGB invoice has no recipient id', 'RGB_L1', 'INVALID_REQUEST')
    const expiration = data?.expirationTimestamp ?? data?.expiration_timestamp
    return {
      recipientId: String(recipientId),
      assetId: data?.assetId ?? data?.asset_id ?? null,
      transportEndpoints: data?.transportEndpoints ?? data?.transport_endpoints ?? [],
      publicKey: data?.publicKey ?? data?.public_key ?? null,
      encryption: data?.encryption ?? null,
      expirationTimestamp: expiration == null ? null : toFiniteNumber(expiration),
    }
  }

  private async sendRecipients(
    recipientMap: Record<string, Record<string, unknown>[]>,
    opts: { feeRate?: number; minConfirmations?: number; donation?: boolean; signal?: AbortSignal; dryRun?: boolean },
  ): Promise<any> {
    // Recipients post their ACK to, and fetch the signed TX from, the sender's proxy.
    const senderEndpoint = this.transportEndpoints[0]
    if (!senderEndpoint) {
      throw new ProtocolError('An RGB-L1 send needs a transport endpoint of its own', 'RGB_L1', 'CONFIG')
    }
    const expirationTimestamp = operationExpiration(recipientMap, opts.donation ?? false)
    // rgb-lib's `send` only spends *settled* allocations it knows locally, so
    // without a fresh sync+refresh sendBegin fails with "Insufficient total
    // assignments" despite a non-zero UI balance.
    await this.refreshBalances({ signal: opts.signal })
    const feeRate = BigInt(Math.round(opts.feeRate ?? defaultRgbFeeRate(this.network)))
    const begin: any = await this.account.sendBegin(
      this.online,
      recipientMap,
      opts.donation ?? false,
      feeRate,
      opts.minConfirmations ?? 1,
      expirationTimestamp,
      senderEndpoint,
      null,
      opts.dryRun ?? false,
      opts.signal ?? null,
    )
    if (opts.dryRun) return this.inspectRgbPsbt(begin?.psbt ?? begin)
    const signed = await this.account.signPsbt(begin?.psbt ?? begin)
    const result = await this.account.sendEnd(this.online, signed)
    // The spend is broadcast; persist the consumed-allocation state so a SW kill
    // can't leave the wallet thinking the inputs are still spendable (which would
    // later fail as "insufficient assignments" or attempt a double-spend).
    await this.flushState()
    // `entropy` is a random u64 that reaches JS as a BigInt, which a host's
    // structured clone or JSON message transport cannot carry.
    return {
      txid: typeof result?.txid === 'string' ? result.txid : '',
      batchTransferIdx: result?.batchTransferIdx != null ? Number(result.batchTransferIdx) : undefined,
      entropy: result?.entropy != null ? String(result.entropy) : undefined,
    }
  }

  async sendBtcOnchain(params: SendBtcParams): Promise<any> {
    const txid: string = await this.endVanilla(
      () => this.beginSendBtc(params, false),
      (signed) => this.account.sendBtcEnd(this.online, signed),
    )
    await this.flushState()
    // A successful send must be traceable and reconcilable.
    if (!txid) {
      throw new ProtocolError('BTC send did not return a transaction ID', 'RGB_L1', 'SEND_ERROR')
    }
    return { ok: true, txid }
  }

  /** The PSBT a BTC send would sign, with its exact fee; nothing is reserved. */
  async previewSendBtc(params: SendBtcParams): Promise<RgbPsbtSummary> {
    return this.inspectRgbPsbt(await this.beginSendBtc(params, true))
  }

  private async beginSendBtc(params: SendBtcParams, dryRun: boolean): Promise<string> {
    this.assertConnected()
    const feeRate = BigInt(Math.round(params.feeRate ?? defaultRgbFeeRate(this.network)))
    return this.account.sendBtcBegin(
      this.online,
      params.address,
      BigInt(params.amount),
      feeRate,
      false,
      dryRun,
      params.signal ?? null,
    )
  }

  /** Read-only summary of a PSBT: inputs, outputs, fee and which of them are the wallet's own. */
  async inspectRgbPsbt(psbt: string): Promise<RgbPsbtSummary> {
    this.assertConnected()
    return toRgbPsbtSummary(await this.account.inspectPsbt(psbt))
  }

  /** Imports an asset from a transfer consignment (bytes or base64) so invoices can be made for it. */
  async importRgbAsset(params: { consignment: Uint8Array | string; txid: string }): Promise<void> {
    this.assertConnected()
    const bytes =
      typeof params.consignment === 'string'
        ? Uint8Array.from(atob(params.consignment), (c) => c.charCodeAt(0))
        : params.consignment
    await this.account.saveNewAsset(this.online, bytes, params.txid)
    await this.flushState()
  }

  // --- UTXOs / fees / metadata / transfer maintenance ---------------------
  /**
   * List unspent outputs and their RGB allocations, normalizing rgb-lib's
   * camel/snake casing and `Outpoint` (object or `"txid:vout"`) into a flat shape.
   */
  async listRgbUnspents(): Promise<{
    unspents: Array<{
      utxo: { outpoint: string; btc_amount: number; colorable: boolean }
      rgb_allocations: Array<{ asset_id?: string | null; assignment: unknown; settled: boolean }>
    }>
  }> {
    this.assertConnected()
    const raw: any = await this.account.listUnspents(this.online, false, true)
    const list: any[] = Array.isArray(raw) ? raw : raw?.unspents ?? []
    return {
      unspents: list.map((u) => {
        const utxo = u?.utxo ?? u ?? {}
        const allocations: any[] = u?.rgbAllocations ?? u?.rgb_allocations ?? []
        return {
          utxo: {
            outpoint: formatOutpoint(utxo.outpoint),
            btc_amount: toFiniteNumber(utxo.btcAmount ?? utxo.btc_amount ?? 0),
            colorable: Boolean(utxo.colorable),
          },
          rgb_allocations: allocations.map((a) => ({
            asset_id: a?.assetId ?? a?.asset_id ?? null,
            assignment: a?.assignment ?? null,
            settled: Boolean(a?.settled),
          })),
        }
      }),
    }
  }

  /** Estimate the on-chain fee rate (sat/vB) for a confirmation target (IProtocolAdapter hook). */
  async estimateRgbFee(blocks: number): Promise<{ fee_rate: number }> {
    this.assertConnected()
    const target = Number.isFinite(blocks) && blocks > 0 ? Math.round(blocks) : 6
    const rate = await this.account.getFeeEstimation(this.online, target)
    return { fee_rate: toFiniteNumber(rate) }
  }

  /** Asset metadata (name, ticker, precision, supply). */
  async getAssetMetadata(assetId: string): Promise<Record<string, unknown>> {
    this.assertConnected()
    const meta: any = await this.account.getAssetMetadata(assetId)
    return {
      asset_id: assetId,
      asset_schema: meta?.assetSchema ?? meta?.asset_schema,
      name: meta?.name,
      ticker: meta?.ticker,
      precision: meta?.precision,
      initial_supply: toFiniteNumber(meta?.initialSupply ?? meta?.initial_supply ?? 0),
      max_supply: meta?.maxSupply ?? meta?.max_supply,
      known_circulating_supply: meta?.knownCirculatingSupply ?? meta?.known_circulating_supply,
      timestamp: meta?.timestamp,
    }
  }

  /**
   * Status of a received invoice, matched by recipient id / invoice string.
   */
  async getInvoiceStatus(params: { invoice: string }): Promise<unknown> {
    this.assertConnected()
    const needle = String(params.invoice ?? '')
    const transfers = await this.listAllTransfers()
    const match = transfers.find((t) => {
      const fields = [t?.recipientId, t?.recipient_id, t?.invoiceString, t?.invoice_string, t?.invoice]
      return fields.some((f) => f && String(f) === needle)
    })
    return { status: match?.status ?? null, transfer: match ?? null }
  }

  /**
   * Fail expired/stuck pending transfers (default: all). Stuck WaitingCounterparty
   * transfers hold allocations and can block a later spend.
   */
  async failRgbTransfers(
    params: { batchTransferIdx?: number | null; noAssetOnly?: boolean } = {},
  ): Promise<{ changed: boolean }> {
    this.assertConnected()
    const changed: boolean = await this.account.failTransfers(
      this.online,
      params.batchTransferIdx ?? null,
      params.noAssetOnly ?? false,
      false,
    )
    await this.flushState()
    return { changed: Boolean(changed) }
  }

  /** Delete already-failed transfers from the wallet DB. */
  async deleteRgbTransfers(
    params: { batchTransferIdx?: number | null; noAssetOnly?: boolean } = {},
  ): Promise<{ changed: boolean }> {
    this.assertConnected()
    const changed: boolean = await this.account.deleteTransfers(
      params.batchTransferIdx ?? null,
      params.noAssetOnly ?? false,
    )
    await this.flushState()
    return { changed: Boolean(changed) }
  }

  /**
   * Durably commit state to IndexedDB. Best-effort and version-guarded: `flush()`
   * postdates beta.2, and a failed flush leaves memory state intact.
   */
  /**
   * Begin, sign and end a vanilla operation. A non-dry begin reserves its
   * inputs until the operation ends or is aborted, so a failure that provably
   * left nothing on the network releases them: a signing failure, or a
   * broadcast the network rejected. Any other end failure keeps the
   * reservation, since the transaction may already be out.
   */
  private async endVanilla<T>(
    begin: () => Promise<string>,
    end: (signed: string) => Promise<T>,
  ): Promise<T> {
    const before = this.pendingVanillaTxids()
    const unsigned = await begin()
    let signed: string
    try {
      signed = await this.account.signPsbt(unsigned)
    } catch (error) {
      await this.abortVanillaSince(before)
      throw error
    }
    try {
      return await end(signed)
    } catch (error) {
      if (isRejectedBroadcast(error)) await this.abortVanillaSince(before)
      throw error
    }
  }

  private pendingVanillaTxids(): Set<string> {
    if (typeof this.account?.listPendingVanillaTxs !== 'function') return new Set()
    try {
      return new Set(vanillaTxids(this.account.listPendingVanillaTxs()))
    } catch {
      return new Set()
    }
  }

  private async abortVanillaSince(before: Set<string>): Promise<void> {
    if (typeof this.account?.abortPendingVanillaTx !== 'function') return
    let aborted = false
    for (const txid of this.pendingVanillaTxids()) {
      if (before.has(txid)) continue
      try {
        this.account.abortPendingVanillaTx(txid)
        aborted = true
      } catch {
        // Left reserved; rgb-lib releases it when the operation expires.
      }
    }
    if (aborted) await this.flushState().catch(() => {})
  }

  private async flushState(): Promise<void> {
    const fn = (this.account as { flush?: unknown } | null)?.flush
    if (typeof fn !== 'function') return
    try {
      await (this.account as { flush: () => Promise<void> }).flush()
    } catch (e) {
      console.error('[RGB-L1] flush failed:', e)
    }
  }

  // --- Backup / VSS ---------------------------------------------------------
  // RGB state can't be rebuilt from the seed, so it is backed up after every
  // settled transfer. rgb-lib encrypts client-side, so VSS only stores ciphertext.
  // Calls route through the account queue, so a backup can't interleave.

  /** Encrypted wallet backup bytes (rgb-lib's own format). */
  async backup(password: string): Promise<Uint8Array> {
    this.assertConnected()
    return this.account.backup(password)
  }

  /** Restore wallet state from encrypted backup bytes produced by {@link backup}. */
  async restoreBackup(params: { backupBytes: Uint8Array; password: string }): Promise<void> {
    this.assertConnected()
    await this.account.restoreBackup(params.backupBytes, params.password)
    await this.flushState()
  }

  /** Whether local wallet state has changed since the last backup. */
  async backupInfo(): Promise<{ required: boolean }> {
    this.assertConnected()
    return { required: Boolean(await this.account.backupInfo()) }
  }

  /** Configure VSS (cloud) backup: server URL, per-wallet store id, signing key (hex). */
  async configureVssBackup(params: {
    serverUrl: string
    storeId: string
    signingKeyHex: string
  }): Promise<void> {
    this.assertConnected()
    await this.account.configureVssBackup(params.serverUrl, params.storeId, params.signingKeyHex)
  }

  /** Disable VSS (cloud) backup for this wallet. */
  async disableVssBackup(): Promise<void> {
    this.assertConnected()
    await this.account.disableVssBackup()
  }

  /** Upload an encrypted backup to the configured VSS server. Returns the new server version. */
  async vssBackup(): Promise<{ serverVersion: number | null }> {
    this.assertConnected()
    // rgb-lib returns the raw server version (may be a BigInt) — normalize so it
    // survives structured-clone across the extension's SW message boundary.
    const raw = await this.account.vssBackup()
    return { serverVersion: raw != null ? toFiniteNumber(raw) : null }
  }

  /** VSS backup status, camelCase and without BigInt. */
  async vssBackupInfo(): Promise<{
    backupExists: boolean
    serverVersion: number | null
    backupRequired: boolean
  }> {
    this.assertConnected()
    const raw = (await this.account.vssBackupInfo()) as Record<string, unknown> | null
    return {
      backupExists: Boolean(raw?.backupExists ?? raw?.backup_exists),
      serverVersion: (raw?.serverVersion ?? raw?.server_version) != null
        ? toFiniteNumber(raw?.serverVersion ?? raw?.server_version)
        : null,
      backupRequired: Boolean(raw?.backupRequired ?? raw?.backup_required),
    }
  }

  /** Download and restore wallet state from the configured VSS server. */
  async vssRestoreBackup(): Promise<void> {
    this.assertConnected()
    await this.account.vssRestoreBackup()
    await this.flushState()
  }

  override async disconnect(): Promise<void> {
    const wallet = this.account as { free?: () => unknown } | null
    this.online = null
    try {
      await super.disconnect()
    } finally {
      // rgb-lib keeps its IndexedDB connection until the wasm wallet is dropped,
      // which blocks a host deleting the store. Queued after pending calls.
      try {
        await wallet?.free?.()
      } catch {
        /* already freed */
      }
    }
  }
}

function isRgbInvoice(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('rgb:')
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * An hour, but never later than rgb-lib allows: the operation must expire
 * INVOICE_EXPIRATION_MARGIN_SECS before the earliest invoice it pays.
 */
function operationExpiration(recipientMap: Record<string, Record<string, unknown>[]>, donation: boolean): number {
  const now = nowSeconds()
  let expiration = now + OPERATION_DURATION_SECS
  if (donation) return expiration
  for (const recipients of Object.values(recipientMap)) {
    for (const r of recipients) {
      if (r.expirationTimestamp == null) continue
      expiration = Math.min(expiration, Number(r.expirationTimestamp) - INVOICE_EXPIRATION_MARGIN_SECS)
    }
  }
  if (expiration <= now) {
    throw new ProtocolError('The RGB invoice expires too soon to pay', 'RGB_L1', 'INVOICE_EXPIRED')
  }
  return expiration
}

function normalizeRgbLibTimestamp(confTime: unknown): number {
  if (typeof confTime === 'number' || typeof confTime === 'string' || typeof confTime === 'bigint') {
    return toFiniteNumber(confTime)
  }
  if (confTime && typeof confTime === 'object') {
    const obj = confTime as Record<string, unknown>
    return firstFiniteNumber(obj.timestamp, obj.blockTime, obj.block_time, obj.time) ?? 0
  }
  return 0
}

/** rgb-lib serializes an Outpoint as `{txid,vout}` or the `"txid:vout"` string. */
function formatOutpoint(outpoint: unknown): string {
  if (typeof outpoint === 'string') return outpoint
  if (outpoint && typeof outpoint === 'object') {
    const o = outpoint as Record<string, unknown>
    const txid = o.txid ?? o.txId
    const vout = o.vout ?? o.index
    if (txid != null && vout != null) return `${txid}:${vout}`
  }
  return ''
}

function toRgbLibAssignment(
  assignment: { type?: string; value?: number } | null | undefined,
  amount: number,
): { Fungible: number } {
  if (assignment?.type && assignment.type !== 'Fungible') {
    throw new ProtocolError(`Unsupported RGB-L1 assignment type: ${assignment.type}`, 'RGB_L1', 'INVALID_REQUEST')
  }
  return { Fungible: Math.round(amount) }
}

function readRgbLibBtcBalanceBucket(bucket: any): { settled: number; spendable: number; future: number } {
  const settled = toFiniteNumber(bucket?.settled ?? bucket?.confirmed ?? bucket?.total ?? 0)
  const spendable = toFiniteNumber(bucket?.spendable ?? bucket?.available ?? settled)
  const future = toFiniteNumber(bucket?.future ?? bucket?.unconfirmed ?? spendable)
  return { settled, spendable, future }
}

/** Map rgb-lib's `TransactionType` to a stable string; unknowns ⇒ "User". */
function normalizeRgbLibTxType(raw: unknown): 'User' | 'RgbSend' | 'CreateUtxos' {
  const v = String(raw ?? '')
  if (v === 'RgbSend' || v === 'CreateUtxos') return v
  return 'User'
}

function normalizeRgbLibTransactionAmounts(t: any): {
  received: number
  sent: number
  type: Extract<UnifiedTransaction['type'], 'send' | 'receive'>
} {
  const explicitReceived = firstFiniteNumber(
    t.received,
    t.receivedSat,
    t.received_sat,
    t.incoming,
    t.incomingSat,
    t.incoming_sat,
  )
  const explicitSent = firstFiniteNumber(
    t.sent,
    t.sentSat,
    t.sent_sat,
    t.outgoing,
    t.outgoingSat,
    t.outgoing_sat,
  )
  if (explicitReceived !== null || explicitSent !== null) {
    const received = explicitReceived ?? 0
    const sent = explicitSent ?? 0
    return { received, sent, type: received >= sent ? 'receive' : 'send' }
  }

  const rawDirection = String(t.type ?? t.direction ?? t.transactionDirection ?? '').toLowerCase()
  const signedAmount = firstFiniteNumber(t.amount, t.amountSat, t.amount_sat, t.value, t.valueSat)
  const amount = Math.abs(signedAmount ?? 0)
  if (rawDirection.includes('send') || rawDirection.includes('out') || (signedAmount ?? 0) < 0) {
    return { received: 0, sent: amount, type: 'send' }
  }
  return { received: amount, sent: 0, type: 'receive' }
}

/**
 * Defensive copy of a raw rgb-lib-wasm return. Current builds hand back plain
 * serde objects, so this is normally a spread; it also honours `toJSON` and
 * walks prototype getters so a build that returns a wasm-bindgen class
 * instance still normalizes instead of collapsing to `{}`.
 */
function plainFromWasm(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {}
  const source = value as Record<string, unknown>
  const toJson = (source as { toJSON?: unknown }).toJSON
  if (typeof toJson === 'function') {
    try {
      return ((toJson as () => unknown).call(source) ?? {}) as Record<string, unknown>
    } catch {
      // fall through to the getter walk
    }
  }
  const out: Record<string, unknown> = { ...source }
  const proto = Object.getPrototypeOf(source) as object | null
  for (const key of proto ? Object.getOwnPropertyNames(proto) : []) {
    if (key === 'constructor' || key in out) continue
    try {
      const read = source[key]
      if (typeof read !== 'function') out[key] = read
    } catch {
      // a wasm getter can throw on a freed pointer — skip it
    }
  }
  return out
}

/**
 * Issuance-only fields rgb-lib-wasm reports alongside the asset record (camelCase
 * or snake_case), exposed on `UnifiedAsset.metadata` so hosts keep them.
 */
function normalizeIssuanceMetadata(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const issuedSupply = firstFiniteNumber(a.issuedSupply, a.issued_supply)
  if (issuedSupply !== null) out.issued_supply = issuedSupply
  const timestamp = firstFiniteNumber(a.timestamp)
  if (timestamp !== null) out.timestamp = timestamp
  const addedAt = firstFiniteNumber(a.addedAt, a.added_at)
  if (addedAt !== null) out.added_at = addedAt
  const media = a.media
  if (media !== null && media !== undefined) out.media = media
  return out
}

/**
 * Normalize an rgb-lib-wasm asset record for `RgbCore.rgbNiaAsset` (it may use
 * camelCase `assetId` or snake_case `asset_id`).
 */
/** The EvmChain options of rgb-lib-wasm's bindings (camel case), with a valid lock window only. */
function toRgbLibEvmChains(chains: Record<string, RgbEvmChain> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [chainId, c] of Object.entries(chains ?? {})) {
    if (!/^[0-9]+$/.test(chainId) || !c?.rpcUrl) continue
    if (!Number.isSafeInteger(c.minMintLockBlocks) || !Number.isSafeInteger(c.maxMintLockBlocks)) continue
    if (c.minMintLockBlocks < 0 || c.minMintLockBlocks > c.maxMintLockBlocks) continue
    out[chainId] = {
      rpcUrl: c.rpcUrl,
      minMintLockBlocks: c.minMintLockBlocks,
      maxMintLockBlocks: c.maxMintLockBlocks,
    }
  }
  return out
}

/** A go-online failure caused by a configured EVM chain. */
function isEvmChainError(e: unknown): boolean {
  return ['Invalid EVM RPC URL', 'EVM chain ID mismatch', 'Invalid EVM chain'].some((p) => wasmErrorStartsWith(e, p))
}

function normalizeAsset(a: any): {
  asset_id: string
  name?: string
  ticker?: string
  precision?: number | string
  balance?: RgbBalanceLike
} {
  return {
    asset_id: a?.assetId ?? a?.asset_id ?? a?.id ?? '',
    name: a?.name,
    ticker: a?.ticker,
    precision: a?.precision,
    balance: normalizeAssetBalance(a?.balance ?? a),
  }
}

function normalizeAssetBalance(a: any): RgbBalanceLike | undefined {
  if (!a) return undefined
  return {
    settled: a.settled ?? a.total,
    future: a.future ?? a.pending,
    spendable: a.spendable ?? a.available,
    offchain_outbound: a.offchain_outbound ?? a.offchainOutbound ?? a.locked,
    offchain_inbound: a.offchain_inbound ?? a.offchainInbound,
  }
}

/** rgb-lib's RefreshResult: a `Map` from serde-wasm-bindgen, or a plain object. */
function refreshEntries(result: unknown): Array<[string, any]> {
  if (result instanceof Map) return [...result.entries()].map(([k, v]) => [String(k), v])
  if (result && typeof result === 'object') return Object.entries(result)
  return []
}

/** A serialized rgb-lib `Error` (`"Variant"` or `{ Variant: { details } }`) as one line. */
function describeRgbLibError(failure: unknown): string {
  if (typeof failure === 'string') return failure
  try {
    return JSON.stringify(failure, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  } catch {
    return String(failure)
  }
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const n = typeof value === 'bigint' ? Number(value) : Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

/** Txids of rgb-lib's pending vanilla operations, whatever the binding's row shape. */
function vanillaTxids(raw: unknown): string[] {
  const rows = Array.isArray(raw) ? raw : raw instanceof Map ? [...raw.values()] : []
  return rows
    .map((row) => (typeof row === 'string' ? row : (row as { txid?: unknown } | null)?.txid))
    .filter((txid): txid is string => typeof txid === 'string' && txid !== '')
}

/**
 * rgb-lib's FailedBroadcast, minus the rejections that mean the transaction
 * (or a spend of its inputs) is already known to the network.
 */
export function isRejectedBroadcast(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (!/failed broadcast/i.test(message)) return false
  return !/already|known|missingorspent|missing-inputs|duplicate|conflict/i.test(message)
}
