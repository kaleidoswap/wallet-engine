/**
 * BoltzChainSwap
 * --------------
 * BTC <-> L-BTC chain swaps against a KaleidoSwap maker over `@kaleidorg/swap-sdk`
 * (Boltz protocol, maker `/v2`). Unlike the RFQ rail in `KaleidoswapSwap`, this
 * moves BTC between chains and never touches RGB. The SDK is self-contained here:
 * it reads the lockup UTXO from Esplora, builds and signs the claim/refund, and
 * broadcasts.
 *
 * UNITS: satoshis throughout. The wasm boundary returns 64-bit values as `bigint`,
 * coerced through `toSats` so a renamed or oversized field fails loudly.
 *
 * MONEY ORDERING: nothing here funds a lockup. `createSwap` returns the binding
 * amounts and the address; the host performs the send, keeping the spend an
 * explicit user-visible step. The lockup must be ONE output for EXACTLY
 * `userLockAmount` — the maker sweeps neither multiple UTXOs nor an overpayment.
 *
 * TRUST: the maker's status strings and `height()` are HINTS. A claim reveals the
 * preimage, the only thing keeping the maker from taking our lockup, so every
 * fact a claim depends on — the maker's lockup exists, pays the swap script for
 * the agreed amount, is buried deep enough, and the timeout is far enough off —
 * is read from the host's trusted `IChainDataProvider` instead. Without one the
 * claim fails closed unless the host opts out by name.
 */

import { Quote, QuoteRequest, Layer, ProtocolError } from '../types/base'
import {
  boltzSwapClientManager,
  makerBaseUrlParam,
  resolveBoltzBaseUrl,
  type SwapMasterKeyLike,
  type SwapScriptLike,
} from '../lib/boltz-swap-client-manager'
import {
  BoltzChainSwapStore,
  decode,
  encode,
  type BoltzChainAsset,
  type BoltzChainSwapPhase,
  type BoltzChainSwapRecord,
} from './boltz-swap-store'
import type { ChainKind, ChainTransaction, IChainDataProvider } from '../ports'
import { EsploraChainDataProvider } from '../lib/esplora-chain-data'
import { scriptPubKeyFromAddress } from '../lib/address-script'
import { log } from '../lib/log'

/** The only layer pair this venue serves. */
const LAYER_ASSET: Partial<Record<Layer, BoltzChainAsset>> = {
  BTC_L1: 'BTC',
  BTC_LIQUID: 'L-BTC',
}

/** Chain kind the SDK expects when rebuilding a swap script. */
const ASSET_CHAIN_KIND: Record<BoltzChainAsset, ChainKind> = {
  BTC: 'bitcoin',
  'L-BTC': 'liquid',
}

/**
 * Coerce a wasm-boundary money field to a number, failing CLOSED on anything that
 * would corrupt downstream math: non-finite, fractional, negative, or past
 * `Number.MAX_SAFE_INTEGER`. Every field coerced is a non-negative sat amount.
 */
function toSats(value: unknown, field: string): number {
  const n = typeof value === 'bigint' ? Number(value) : Number(value)
  if (!Number.isFinite(n)) {
    throw new ProtocolError(`Chain swap field '${field}' is not a finite number`, 'BTC', 'BAD_AMOUNT')
  }
  if (n < 0) {
    throw new ProtocolError(`Chain swap field '${field}' is negative`, 'BTC', 'BAD_AMOUNT')
  }
  if (!Number.isInteger(n)) {
    throw new ProtocolError(`Chain swap field '${field}' must contain whole satoshis`, 'BTC', 'BAD_AMOUNT')
  }
  if (n > Number.MAX_SAFE_INTEGER) {
    throw new ProtocolError(`Chain swap field '${field}' exceeds safe integer precision`, 'BTC', 'BAD_AMOUNT')
  }
  return n
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProtocolError(`Chain swap response is missing '${field}'`, 'BTC', 'BAD_RESPONSE')
  }
  return value
}

function assetForLayer(layer: Layer): BoltzChainAsset {
  const asset = LAYER_ASSET[layer]
  if (!asset) {
    throw new ProtocolError(
      `Chain swaps serve BTC_L1 and BTC_LIQUID only, got '${layer}'`,
      'BTC',
      'NOT_SUPPORTED'
    )
  }
  return asset
}

/** Shape of the pair card the maker returns for a chain pair. */
interface RawChainPair {
  hash: string
  rate: number
  limits: { minimal: unknown; maximal: unknown }
  fees: {
    percentage: number
    minerFees: { server: unknown; user: { claim: unknown; lockup: unknown } }
  }
}

/** The fields of a `createChainSwap` response this venue reads. */
interface RawChainSwapDetails {
  lockupAddress: unknown
  amount: unknown
  timeoutBlockHeight: unknown
  bip21?: unknown
}
interface RawChainSwapResponse {
  id: unknown
  lockupDetails: RawChainSwapDetails
  claimDetails: RawChainSwapDetails
}

export interface BoltzChainSwapConfig {
  /**
   * BIP-39 mnemonic. Seeds the per-swap key and preimage through BIP85 (index
   * 26589), matching the maker's restore endpoint, so a restored wallet can
   * recover swaps it has no records for.
   */
  mnemonic: string
  /** Esplora override for the Bitcoin side. Omit to use the SDK's network default. */
  bitcoinEsploraUrl?: string
  /** Esplora override for the Liquid side. Omit to use the SDK's network default. */
  liquidEsploraUrl?: string
  /** Fee rate for claim/refund transactions, sat/vB. */
  feeSatPerVb?: number
  /**
   * Blocks of headroom between the chain tip and the claim timeout. Defaults
   * follow the reference Boltz clients: 2 on Bitcoin, 10 on Liquid.
   */
  claimTimeoutMarginBlocks?: { bitcoin?: number; liquid?: number }
  /**
   * Trusted chain data for the claim guards: the maker lockup, its depth and the
   * chain tip are read here, never from the maker. Omit to use an Esplora
   * provider over `bitcoinEsploraUrl` / `liquidEsploraUrl` — the endpoints the
   * SDK already broadcasts through. With neither, claims fail closed.
   */
  chainData?: IChainDataProvider
  /** Confirmations the maker lockup needs before a claim. Default 1. */
  minLockupConfirmations?: number
  /**
   * Claim against an UNCONFIRMED maker lockup. The lockup is still verified to
   * exist and pay the swap script; only the depth check is waived. Zero-conf is a
   * bet that the maker will not replace the lockup after seeing the preimage.
   */
  allowZeroConf?: boolean
  /**
   * DANGEROUS. With no chain-data provider for a chain, claim on the maker's word
   * alone (its status and `height()`), the behaviour before the chain checks
   * existed. A provider, when present, is still consulted. Never set in production.
   */
  allowUnverifiedClaims?: boolean
}

const DEFAULT_TIMEOUT_MARGIN_BLOCKS: Record<ChainKind, number> = {
  bitcoin: 2,
  liquid: 10,
}

const DEFAULT_MIN_LOCKUP_CONFIRMATIONS = 1

const TXID_RE = /^[0-9a-f]{64}$/i

/** Outcome of checking the maker lockup against trusted chain data. */
type ServerLockupCheck =
  | {
      verified: true
      txid: string
      hex: string
      confirmations: number
      tip: number
    }
  | { verified: false; reason: string; code: string }

/** Fields of the maker's `chainTxs` response this venue reads. */
interface RawChainSwapTxs {
  serverLock?: { transaction?: { id?: unknown } }
}

export interface CreateChainSwapParams {
  fromLayer: Layer
  toLayer: Layer
  /** Sats to lock. Must sit within the pair's limits. */
  amountSat: number
  /** Minimum maker lockup in sats, approved by the caller; excludes the claim transaction fee. */
  minReceiveAmountSat: number
  /** Wallet address on the destination chain that the claim pays out to. */
  destinationAddress: string
}

export class BoltzChainSwap {
  private master: SwapMasterKeyLike | null = null
  private chainDataProvider: IChainDataProvider | null = null

  constructor(
    private config: BoltzChainSwapConfig,
    private store: BoltzChainSwapStore = BoltzChainSwapStore.fromPlatform()
  ) {
    const min = config.minLockupConfirmations
    if (min !== undefined && (!Number.isSafeInteger(min) || min < 1)) {
      throw new ProtocolError('minLockupConfirmations must be a positive integer', 'BTC', 'BAD_CONFIG')
    }
  }

  /**
   * The trusted chain-data provider for `chain`, or null when the host configured
   * none for it. An Esplora provider is derived from the configured URLs on demand.
   */
  private chainData(chain: ChainKind): IChainDataProvider | null {
    if (this.config.chainData) return this.config.chainData
    if (!this.chainDataProvider) {
      const { bitcoinEsploraUrl, liquidEsploraUrl } = this.config
      if (!bitcoinEsploraUrl && !liquidEsploraUrl) return null
      this.chainDataProvider = new EsploraChainDataProvider({
        bitcoinUrl: bitcoinEsploraUrl,
        liquidUrl: liquidEsploraUrl,
      })
    }
    const provider = this.chainDataProvider
    return provider instanceof EsploraChainDataProvider && !provider.serves(chain) ? null : provider
  }

  private masterKey(): SwapMasterKeyLike {
    if (this.master) return this.master
    const sdk = boltzSwapClientManager.getSdk()
    const { network } = boltzSwapClientManager.getConfig()
    this.master = sdk.SwapMasterKey.fromWalletMnemonic(this.config.mnemonic, network)
    return this.master
  }

  /**
   * xpub for `swapRestore` when recovering swaps without local records. Pass `"m"`
   * as the derivation path — the API defaults to something else.
   */
  restoreXpub(): string {
    return this.masterKey().masterXpub()
  }

  /**
   * INDICATIVE quote from the maker's pair card; the binding numbers are the ones
   * in the `createSwap` result. Mirrors the SDK's own fee helper, so it previews
   * closely. `expiresAt` is 0 — there is no server-side quote to expire.
   */
  async getQuote(req: QuoteRequest & { fromLayer: Layer; toLayer: Layer }): Promise<Quote> {
    if (req.fromAmount == null) {
      throw new ProtocolError('Chain swap quote requires fromAmount', 'BTC', 'NO_AMOUNT')
    }
    const from = assetForLayer(req.fromLayer)
    const to = assetForLayer(req.toLayer)
    if (from === to) {
      throw new ProtocolError('Chain swap requires two different chains', 'BTC', 'NOT_SUPPORTED')
    }
    const amount = req.fromAmount
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new ProtocolError(
        'Chain swap quote requires a positive safe integer sat amount',
        'BTC',
        'BAD_AMOUNT'
      )
    }
    const client = boltzSwapClientManager.getClient()
    const pairs = (await client.chainPairs()) as Record<string, Record<string, RawChainPair>>
    const pair = pairs?.[from]?.[to]
    if (!pair) {
      throw new ProtocolError(`Maker serves no ${from} -> ${to} chain pair`, 'BTC', 'NO_PAIR')
    }

    const minimal = toSats(pair.limits?.minimal, 'limits.minimal')
    const maximal = toSats(pair.limits?.maximal, 'limits.maximal')
    if (amount < minimal || amount > maximal) {
      throw new ProtocolError(
        `Amount ${amount} sat is outside the pair limits (${minimal}-${maximal} sat)`,
        'BTC',
        'OUT_OF_LIMITS'
      )
    }

    const percentage = Number(pair.fees?.percentage)
    if (!Number.isFinite(percentage) || percentage < 0) {
      throw new ProtocolError('Chain pair fee percentage is not a valid number', 'BTC', 'BAD_AMOUNT')
    }
    const serviceFee = toSats(Math.ceil((percentage / 100) * amount), 'fees.percentage')
    const claimFee = toSats(pair.fees?.minerFees?.user?.claim, 'minerFees.user.claim')
    const lockupFee = toSats(pair.fees?.minerFees?.user?.lockup, 'minerFees.user.lockup')
    const serverFee = toSats(pair.fees?.minerFees?.server, 'minerFees.server')
    const fee = toSats(serviceFee + claimFee + lockupFee + serverFee, 'fees.total')

    const rate = Number(pair.rate)
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new ProtocolError('Chain pair rate is not a valid number', 'BTC', 'BAD_AMOUNT')
    }
    const grossToAmount = toSats(Math.floor(amount * rate), 'toAmount.gross')
    const toAmount = grossToAmount - fee
    if (toAmount <= 0) {
      throw new ProtocolError(
        `Fees (${fee} sat) exceed the swap amount (${amount} sat)`,
        'BTC',
        'AMOUNT_TOO_SMALL'
      )
    }

    return {
      id: requireString(pair.hash, 'pair.hash'),
      fromAsset: from,
      fromAmount: amount,
      toAsset: to,
      toAmount,
      price: rate,
      fee: {
        amount: fee,
        asset: from,
        breakdown: { baseFee: 0, variableFee: serviceFee, networkFee: claimFee + lockupFee + serverFee },
      },
      expiresAt: 0,
      provider: 'kaleidoswap-boltz',
    }
  }

  /**
   * Create the swap at the maker and persist it BEFORE returning, so the record
   * that makes funds recoverable exists by the time the caller sees the lockup
   * address. Nothing is spent here: fund `record.lockupAddress` with exactly
   * `record.userLockAmount` in one output, then call `markLockupFunded`.
   */
  async createSwap(params: CreateChainSwapParams): Promise<BoltzChainSwapRecord> {
    params = { ...params }
    const from = assetForLayer(params.fromLayer)
    const to = assetForLayer(params.toLayer)
    if (from === to) {
      throw new ProtocolError('Chain swap requires two different chains', 'BTC', 'NOT_SUPPORTED')
    }
    if (!Number.isSafeInteger(params.amountSat) || params.amountSat <= 0) {
      throw new ProtocolError('Chain swap requires a positive integer sat amount', 'BTC', 'NO_AMOUNT')
    }
    if (!Number.isSafeInteger(params.minReceiveAmountSat) || params.minReceiveAmountSat <= 0) {
      throw new ProtocolError('Chain swap requires a positive integer minimum receive amount', 'BTC', 'NO_AMOUNT')
    }
    if (!params.destinationAddress) {
      throw new ProtocolError('Chain swap requires a destination address', 'BTC', 'NO_ADDRESS')
    }

    const client = boltzSwapClientManager.getClient()
    const { network } = boltzSwapClientManager.getConfig()
    const master = this.masterKey()

    // Reserved before the create call: the preimage is derived from the index, so
    // reusing one makes the maker reject the request as a duplicate swap until the
    // earlier one expires.
    const index = await this.store.nextIndex()
    const key = master.deriveSwapKey(BigInt(index))
    const preimage = master.derivePreimage(BigInt(index))

    const response = (await client.createChainSwap(network, {
      from,
      to,
      preimageHash: preimage.sha256,
      claimPublicKey: key.publicKey,
      refundPublicKey: key.publicKey,
      userLockAmount: BigInt(params.amountSat),
    })) as RawChainSwapResponse

    // `lockupDetails` is our side (paid with the refund key), `claimDetails` is the
    // maker's side (spent with the claim key) — the pairing the SDK validates the
    // response against before it hands it back.
    const swapId = requireString(response?.id, 'id')
    const userLockAmount = toSats(response?.lockupDetails?.amount, 'lockupDetails.amount')
    if (userLockAmount !== params.amountSat) {
      throw new ProtocolError(
        `Maker funding amount ${userLockAmount} sat does not match requested ${params.amountSat} sat`,
        'BTC',
        'AMOUNT_MISMATCH'
      )
    }
    const serverLockAmount = toSats(response?.claimDetails?.amount, 'claimDetails.amount')
    if (serverLockAmount < params.minReceiveAmountSat) {
      throw new ProtocolError('Maker claim amount is below the minimum receive amount', 'BTC', 'AMOUNT_MISMATCH')
    }
    const claimTimeoutBlockHeight = toSats(
      response?.claimDetails?.timeoutBlockHeight, 'claimDetails.timeoutBlockHeight'
    )
    const chain = ASSET_CHAIN_KIND[to]
    const provider = this.chainData(chain)
    if (!provider) {
      throw new ProtocolError('Creating a chain swap requires trusted destination chain data', 'BTC', 'NO_CHAIN_DATA')
    }
    const tip = await provider.tipHeight(chain)
    if (!Number.isSafeInteger(tip) || tip < 0) {
      throw new ProtocolError('Invalid trusted chain tip', 'BTC', 'BAD_RESPONSE')
    }
    const margin = this.config.claimTimeoutMarginBlocks?.[chain] ?? DEFAULT_TIMEOUT_MARGIN_BLOCKS[chain]
    if (!Number.isSafeInteger(margin) || margin < 0 || claimTimeoutBlockHeight <= tip + margin) {
      throw new ProtocolError('Insufficient claim timeout headroom', 'BTC', 'CLAIM_WINDOW_CLOSED')
    }
    const now = Date.now()
    const record: BoltzChainSwapRecord = {
      swapId,
      index,
      from,
      to,
      userLockAmount,
      serverLockAmount,
      claimTimeoutBlockHeight,
      lockupAddress: requireString(response?.lockupDetails?.lockupAddress, 'lockupDetails.lockupAddress'),
      lockupBip21:
        typeof response?.lockupDetails?.bip21 === 'string' ? response.lockupDetails.bip21 : undefined,
      destinationAddress: params.destinationAddress,
      phase: 'created',
      createdAt: now,
      updatedAt: now,
      response: encode(response),
    }
    await this.store.put(record)
    return record
  }

  /**
   * Record the lockup funding tx. Call as soon as the send is broadcast — from
   * here the swap has funds at risk and must reach a claim or a refund.
   */
  async markLockupFunded(swapId: string, lockupTxid: string): Promise<BoltzChainSwapRecord> {
    const record = await this.require(swapId)
    const updated: BoltzChainSwapRecord = {
      ...record,
      phase: record.phase === 'created' ? 'lockup_funded' : record.phase,
      lockupTxid,
      updatedAt: Date.now(),
    }
    await this.store.put(updated)
    return updated
  }

  /**
   * Poll the maker and advance the local phase. The reconciliation path replacing
   * the SDK's WebSocket stream, which an evicted service worker would drop.
   *
   * Maker statuses are hints. `transaction.server.confirmed` only reaches
   * `server_locked` once the trusted provider shows the lockup at the required
   * depth; `transaction.claimed` only sets `userLockupSpent` once the provider
   * shows a spend of our lockup carrying the preimage. A hint the chain does not
   * back holds the previous phase.
   */
  async sync(swapId: string): Promise<BoltzChainSwapRecord> {
    const record = await this.require(swapId)
    const client = boltzSwapClientManager.getClient()
    const raw = (await client.swap(swapId)) as { status?: unknown }
    const status = typeof raw?.status === 'string' ? raw.status : undefined
    const updated: BoltzChainSwapRecord = {
      ...record,
      status,
      phase: nextPhase(record.phase, status),
      updatedAt: Date.now(),
    }

    if (updated.phase === 'server_locked' && record.phase !== 'server_locked') {
      const check = await this.checkServerLockup(record).catch((error: unknown) => ({
        verified: false as const,
        reason: error instanceof Error ? error.message : String(error),
        code: 'CHAIN_DATA_UNAVAILABLE',
      }))
      if (check.verified) {
        updated.serverLockupTxid = check.txid
        updated.serverLockupConfirmations = check.confirmations
      } else if (check.code === 'NO_CHAIN_DATA' && this.config.allowUnverifiedClaims) {
        log.warn(`[BoltzChainSwap] ${swapId}: taking the maker's word for its lockup (allowUnverifiedClaims)`)
      } else {
        log.warn(
          `[BoltzChainSwap] ${swapId}: maker reports its lockup confirmed, holding at server_locking: ${check.reason}`
        )
        updated.phase = 'server_locking'
      }
    }

    if (!record.userLockupSpent && status === 'transaction.claimed') {
      const spent = await this.observeUserLockupSpend(record).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        log.warn(`[BoltzChainSwap] ${swapId}: could not verify the maker's spend of our lockup: ${reason}`)
        return false
      })
      if (spent) updated.userLockupSpent = true
    }

    await this.store.put(updated)
    return updated
  }

  /**
   * Claim the maker's lockup to `destinationAddress`.
   *
   * Refuses unless the trusted chain-data provider shows the maker lockup paying
   * the swap script for the agreed amount at `minLockupConfirmations` depth: a
   * claim publishes the preimage, the only thing stopping the maker from taking
   * our lockup, so spending that secret against a still-replaceable transaction
   * is a one-sided bet. The claim is then pinned to that exact transaction.
   *
   * Also refuses within `claimTimeoutMarginBlocks` of the timeout, by the
   * provider's tip, where the claim would race the maker's refund — unless the
   * maker already spent our lockup, in which case the preimage is public and
   * claiming late is strictly better.
   *
   * Takes the non-cooperative script path: the cooperative MuSig2 keyspend needs a
   * signature exchange the SDK's params object cannot express.
   */
  async claim(swapId: string): Promise<BoltzChainSwapRecord> {
    const record = await this.require(swapId)
    if (record.phase === 'claimed') return record
    const lockup = await this.assertClaimable(record)
    const script = this.buildScript(record, 'claim')
    const master = this.masterKey()
    const key = master.deriveSwapKey(BigInt(record.index))
    const preimage = master.derivePreimage(BigInt(record.index))
    const tx = await script.constructClaim(preimage.preimage, {
      ...this.txParams(record, key.secretKey),
      cooperative: false,
      ...(lockup
        ? { claimLockup: { chain: ASSET_CHAIN_KIND[record.to], hex: lockup.hex, txid: lockup.txid } }
        : {}),
    })
    const claimTxid = requireString(
      await tx.broadcast(
        boltzSwapClientManager.getConfig().network,
        this.config.bitcoinEsploraUrl ?? null,
        this.config.liquidEsploraUrl ?? null,
        null
      ),
      'claim transaction id'
    )
    const updated: BoltzChainSwapRecord = {
      ...record,
      phase: 'claimed',
      claimTxid,
      ...(lockup
        ? { serverLockupTxid: lockup.txid, serverLockupConfirmations: lockup.confirmations }
        : {}),
      updatedAt: Date.now(),
    }
    await this.store.put(updated)
    return updated
  }

  /**
   * Refund our own lockup to `destinationAddress` after failure or expiry. Fails
   * until the lockup timelock passes — that is the maker enforcing the timeout.
   */
  async refund(swapId: string): Promise<BoltzChainSwapRecord> {
    const record = await this.require(swapId)
    if (record.phase === 'refunded') return record
    if (!record.lockupTxid) {
      throw new ProtocolError(
        `Swap ${swapId} has no recorded lockup — nothing to refund`,
        'BTC',
        'NOT_FUNDED'
      )
    }
    const script = this.buildScript(record, 'lockup')
    const key = this.masterKey().deriveSwapKey(BigInt(record.index))
    const tx = await script.constructRefund(this.txParams(record, key.secretKey))
    const refundTxid = requireString(
      await tx.broadcast(
        boltzSwapClientManager.getConfig().network,
        this.config.bitcoinEsploraUrl ?? null,
        this.config.liquidEsploraUrl ?? null,
        null
      ),
      'refund transaction id'
    )
    const updated: BoltzChainSwapRecord = {
      ...record,
      phase: 'refunded',
      refundTxid,
      updatedAt: Date.now(),
    }
    await this.store.put(updated)
    return updated
  }

  /**
   * Swaps still owing an action — the work list for a resume-on-unlock pass.
   * Excludes settled swaps and ones that expired before we funded them.
   */
  async listPending(): Promise<BoltzChainSwapRecord[]> {
    const records = await this.store.list()
    return records.filter(
      (r) => r.phase !== 'claimed' && r.phase !== 'refunded' && r.phase !== 'failed'
    )
  }

  /**
   * Gate on the two conditions making a claim safe: the maker's lockup is
   * verified on chain at the required depth, and the claim timeout is far enough
   * off (by the trusted tip) to land first. Both are waived once
   * `userLockupSpent` is set — the preimage is already public — though the lockup
   * is still located when a provider is available, so the claim can be pinned.
   *
   * Returns the verified lockup, or null when no provider serves the chain and
   * the host opted into `allowUnverifiedClaims`.
   */
  private async assertClaimable(
    record: BoltzChainSwapRecord
  ): Promise<{ txid: string; hex: string; confirmations: number } | null> {
    const chainKind = ASSET_CHAIN_KIND[record.to]
    const provider = this.chainData(chainKind)

    if (record.userLockupSpent) {
      if (!provider) return null
      const check = await this.checkServerLockup(record, { allowZeroConf: true })
      return check.verified ? check : null
    }

    if (record.phase !== 'server_locked' && record.phase !== 'server_locking') {
      throw new ProtocolError(
        `Swap '${record.swapId}' is not claimable in phase '${record.phase}'`,
        'BTC',
        'NOT_CLAIMABLE'
      )
    }

    const margin =
      this.config.claimTimeoutMarginBlocks?.[chainKind] ?? DEFAULT_TIMEOUT_MARGIN_BLOCKS[chainKind]

    if (!provider) {
      if (!this.config.allowUnverifiedClaims) {
        throw new ProtocolError(
          `Cannot verify the maker lockup for swap '${record.swapId}': no trusted chain-data provider serves ${chainKind}. Configure chainData or ${chainKind}EsploraUrl, or set allowUnverifiedClaims to claim on the maker's word`,
          'BTC',
          'NO_CHAIN_DATA'
        )
      }
      // Explicit opt-out: the maker's status and tip are all there is.
      if (record.phase !== 'server_locked') {
        throw new ProtocolError(
          `Maker lockup for swap '${record.swapId}' is unconfirmed — claiming now would reveal the preimage against a replaceable transaction`,
          'BTC',
          'NOT_CLAIMABLE'
        )
      }
      const heights = (await boltzSwapClientManager.getClient().height()) as Record<string, unknown>
      const tip = toSats(heights?.[record.to], `height.${record.to}`)
      this.assertClaimWindowOpen(record, chainKind, tip, margin)
      return null
    }

    const check = await this.checkServerLockup(record)
    if (!check.verified) {
      throw new ProtocolError(
        `Maker lockup for swap '${record.swapId}' is not claimable: ${check.reason}`,
        'BTC',
        check.code
      )
    }
    this.assertClaimWindowOpen(record, chainKind, check.tip, margin)
    return check
  }

  private assertClaimWindowOpen(
    record: BoltzChainSwapRecord,
    chainKind: ChainKind,
    tip: number,
    margin: number
  ): void {
    if (tip > record.claimTimeoutBlockHeight - margin) {
      throw new ProtocolError(
        `Claim window for swap '${record.swapId}' has closed: ${chainKind} tip ${tip} is within ${margin} blocks of the timeout at ${record.claimTimeoutBlockHeight}`,
        'BTC',
        'CLAIM_WINDOW_CLOSED'
      )
    }
  }

  /**
   * Verify the maker's lockup against trusted chain data: the transaction the
   * maker names (a hint — the only thing taken from it) must exist on the
   * destination chain, pay an output to the claim-side swap script for
   * `serverLockAmount`, and sit `minLockupConfirmations` deep. Liquid hides the
   * amount of a blinded output; the SDK unblinds and checks it when it builds the
   * claim, so only a visible amount is compared here.
   */
  private async checkServerLockup(
    record: BoltzChainSwapRecord,
    options: { allowZeroConf?: boolean } = {}
  ): Promise<ServerLockupCheck> {
    const chainKind = ASSET_CHAIN_KIND[record.to]
    const provider = this.chainData(chainKind)
    if (!provider) {
      return {
        verified: false,
        reason: `no trusted chain-data provider serves ${chainKind}`,
        code: 'NO_CHAIN_DATA',
      }
    }

    let txid = record.serverLockupTxid ?? (await this.makerServerLockupTxid(record.swapId))
    if (!txid) {
      return { verified: false, reason: 'the maker reports no lockup transaction', code: 'NOT_CLAIMABLE' }
    }

    let tx = await provider.getTransaction(chainKind, txid)
    if (!tx && record.serverLockupTxid) {
      // A previously verified lockup that vanished (reorg, replacement): ask the
      // maker again rather than pinning a transaction the chain no longer has.
      const fresh = await this.makerServerLockupTxid(record.swapId)
      if (fresh && fresh !== txid) {
        txid = fresh
        tx = await provider.getTransaction(chainKind, txid)
      }
    }
    if (!tx) {
      return {
        verified: false,
        reason: `lockup ${txid} is unknown to the ${chainKind} chain source`,
        code: 'LOCKUP_NOT_FOUND',
      }
    }
    if (tx.txid.toLowerCase() !== txid.toLowerCase()) {
      return { verified: false, reason: `chain source returned ${tx.txid} for ${txid}`, code: 'BAD_CHAIN_DATA' }
    }

    const expectedScript = this.serverLockupScript(record)
    const output = tx.vout.find((o) => o.scriptPubKey.toLowerCase() === expectedScript)
    if (!output) {
      return {
        verified: false,
        reason: `lockup ${txid} pays no output to the swap script`,
        code: 'LOCKUP_MISMATCH',
      }
    }
    if (output.valueSat !== undefined && output.valueSat !== record.serverLockAmount) {
      return {
        verified: false,
        reason: `lockup ${txid} pays ${output.valueSat} sat, expected ${record.serverLockAmount} sat`,
        code: 'LOCKUP_MISMATCH',
      }
    }

    const tip = await provider.tipHeight(chainKind)
    const confirmations = tx.blockHeight === undefined ? 0 : Math.max(0, tip - tx.blockHeight + 1)
    const minimum = this.config.minLockupConfirmations ?? DEFAULT_MIN_LOCKUP_CONFIRMATIONS
    const zeroConf = options.allowZeroConf ?? this.config.allowZeroConf ?? false
    if (!zeroConf && confirmations < minimum) {
      return {
        verified: false,
        reason: `lockup ${txid} has ${confirmations} confirmation(s) on ${chainKind}, needs ${minimum} — claiming now would reveal the preimage against a replaceable transaction`,
        code: 'LOCKUP_UNCONFIRMED',
      }
    }
    return { verified: true, txid: tx.txid, hex: tx.hex, confirmations, tip }
  }

  /** The maker's claimed lockup txid, validated as a txid and nothing more. */
  private async makerServerLockupTxid(swapId: string): Promise<string | null> {
    const raw = (await boltzSwapClientManager.getClient().chainTxs(swapId)) as RawChainSwapTxs | null
    const id = raw?.serverLock?.transaction?.id
    if (typeof id !== 'string' || !TXID_RE.test(id)) return null
    return id.toLowerCase()
  }

  /** scriptPubKey of the maker's lockup, from the create response we validated. */
  private serverLockupScript(record: BoltzChainSwapRecord): string {
    const response = decode(record.response) as { claimDetails?: { lockupAddress?: unknown } }
    const address = response?.claimDetails?.lockupAddress
    if (typeof address !== 'string' || !address) {
      throw new ProtocolError(
        `Stored response for swap '${record.swapId}' has no claimDetails.lockupAddress`,
        'BTC',
        'BAD_RECORD'
      )
    }
    return scriptPubKeyFromAddress(address).toLowerCase()
  }

  /**
   * Whether the source chain shows our lockup output spent by a transaction whose
   * witness carries the swap preimage — the maker's claim, the only spend that
   * proves the secret is public. A refund spends it too, without the preimage.
   */
  private async observeUserLockupSpend(record: BoltzChainSwapRecord): Promise<boolean> {
    const chainKind = ASSET_CHAIN_KIND[record.from]
    const provider = this.chainData(chainKind)
    if (!provider) {
      throw new ProtocolError(
        `no trusted chain-data provider serves ${chainKind}`,
        'BTC',
        'NO_CHAIN_DATA'
      )
    }
    if (!record.lockupTxid || !TXID_RE.test(record.lockupTxid)) return false
    const lockupTx = await provider.getTransaction(chainKind, record.lockupTxid)
    if (!lockupTx) return false
    const script = scriptPubKeyFromAddress(record.lockupAddress).toLowerCase()
    const vout = lockupTx.vout.findIndex((o) => o.scriptPubKey.toLowerCase() === script)
    if (vout < 0) return false
    const outspend = await provider.getOutspend(chainKind, lockupTx.txid, vout)
    if (!outspend.spent || !outspend.txid || outspend.vin === undefined) return false
    const spend = await provider.getTransaction(chainKind, outspend.txid)
    if (!spend) return false
    const preimage = this.masterKey().derivePreimage(BigInt(record.index)).preimage.toLowerCase()
    return witnessRevealsPreimage(spend, outspend.vin, preimage)
  }

  private async require(swapId: string): Promise<BoltzChainSwapRecord> {
    const record = await this.store.get(swapId)
    if (!record) {
      throw new ProtocolError(`Unknown chain swap '${swapId}'`, 'BTC', 'NOT_FOUND')
    }
    return record
  }

  /**
   * Rebuild the swap script from the stored create response. `side` picks the half:
   * 'claim' is the maker's lockup, 'lockup' is ours.
   */
  private buildScript(record: BoltzChainSwapRecord, side: 'claim' | 'lockup'): SwapScriptLike {
    const sdk = boltzSwapClientManager.getSdk()
    const { network } = boltzSwapClientManager.getConfig()
    const response = decode(record.response) as Record<string, unknown>
    const details = side === 'claim' ? response.claimDetails : response.lockupDetails
    if (!details) {
      throw new ProtocolError(
        `Stored response for swap '${record.swapId}' has no ${side}Details`,
        'BTC',
        'BAD_RECORD'
      )
    }
    const chainKind = ASSET_CHAIN_KIND[side === 'claim' ? record.to : record.from]
    const key = this.masterKey().deriveSwapKey(BigInt(record.index))
    return sdk.SwapScript.fromChain(chainKind, network, side, details, key.publicKey)
  }

  private txParams(record: BoltzChainSwapRecord, keysSecretHex: string): Record<string, unknown> {
    return {
      outputAddress: record.destinationAddress,
      swapId: record.swapId,
      keysSecretHex,
      ...makerBaseUrlParam(
        boltzSwapClientManager.getSdk(),
        resolveBoltzBaseUrl(boltzSwapClientManager.getConfig())
      ),
      network: boltzSwapClientManager.getConfig().network,
      bitcoinEsploraUrl: this.config.bitcoinEsploraUrl,
      liquidEsploraUrl: this.config.liquidEsploraUrl,
      feeSatPerVb: this.config.feeSatPerVb,
    }
  }
}

/** True when input `vin` of `tx` carries `preimage` (hex) in its witness stack. */
export function witnessRevealsPreimage(tx: ChainTransaction, vin: number, preimage: string): boolean {
  const input = tx.vin[vin]
  if (!input) return false
  const want = preimage.toLowerCase()
  return input.witness.some((item) => item.toLowerCase() === want)
}

/**
 * Fold a maker status into the local phase. Locally-terminal phases win: once a
 * claim or refund is broadcast a server status cannot walk the record backwards,
 * and unknown statuses leave the phase untouched.
 *
 * `transaction.claimed` means the SERVER claimed OUR lockup, only possible after
 * our claim revealed the preimage, so it does not set 'claimed'.
 */
export function nextPhase(current: BoltzChainSwapPhase, status?: string): BoltzChainSwapPhase {
  if (current === 'claimed' || current === 'refunded') return current
  const funded = current !== 'created'
  switch (status) {
    case 'transaction.mempool':
    case 'transaction.confirmed':
      return current === 'created' ? 'lockup_funded' : current
    // Mempool-only: seen, not claimable. The maker can still replace an
    // RBF-signalling lockup, and our claim would already have published the
    // preimage. Confirmation is what makes the lockup ours to take.
    case 'transaction.server.mempool':
      return current === 'server_locked' ? current : 'server_locking'
    case 'transaction.server.confirmed':
      return 'server_locked'
    case 'transaction.lockupFailed':
    case 'transaction.failed':
    case 'transaction.refunded':
    case 'swap.expired':
      return funded ? 'refundable' : 'failed'
    default:
      return current
  }
}
