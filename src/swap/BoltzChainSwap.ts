/**
 * BoltzChainSwap
 * --------------
 * BTC <-> L-BTC chain swaps against a KaleidoSwap maker over `@kaleidorg/swap-sdk`
 * (Boltz protocol, maker `/v2`). This is the second swap venue in the engine: the
 * RFQ rail in `KaleidoswapSwap` settles cross-asset trades over RLN and owns RGB,
 * while this one moves BTC between chains and never touches RGB.
 *
 * The SDK is self-contained for this leg — it reads the lockup UTXO from Esplora,
 * builds and signs the claim/refund, and broadcasts. The wallet supplies only a
 * mnemonic, a destination address, and the on-chain send that funds the lockup.
 *
 * UNITS: every amount on this boundary is in satoshis. The wasm boundary hands
 * back 64-bit values as `bigint`; they are coerced through `toSats` so a renamed
 * or oversized field fails loudly instead of flowing on as `NaN`.
 *
 * MONEY ORDERING: nothing here funds a lockup. `createSwap` returns the maker's
 * binding amounts and the address to pay, and the host performs the send with its
 * own adapter — so the spend stays an explicit, user-visible step. The lockup must
 * be paid as ONE output for EXACTLY `userLockAmount`; the maker does not sweep
 * multiple UTXOs or accept an overpayment as valid.
 */

import { Quote, QuoteRequest, Layer, ProtocolError } from '../types/base'
import {
  boltzSwapClientManager,
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

/** The only layer pair this venue serves. */
const LAYER_ASSET: Partial<Record<Layer, BoltzChainAsset>> = {
  BTC_L1: 'BTC',
  BTC_LIQUID: 'L-BTC',
}

/** Chain kind the SDK expects when rebuilding a swap script. */
const ASSET_CHAIN_KIND: Record<BoltzChainAsset, 'bitcoin' | 'liquid'> = {
  BTC: 'bitcoin',
  'L-BTC': 'liquid',
}

/**
 * Coerce a wasm-boundary money field to a number, failing CLOSED on anything that
 * would corrupt downstream math: non-finite (a renamed/missing field), negative,
 * or past `Number.MAX_SAFE_INTEGER` where JS loses integer precision. Every field
 * this coerces is a non-negative sat amount by definition.
 */
function toSats(value: unknown, field: string): number {
  const n = typeof value === 'bigint' ? Number(value) : Number(value)
  if (!Number.isFinite(n)) {
    throw new ProtocolError(`Chain swap field '${field}' is not a finite number`, 'BTC', 'BAD_AMOUNT')
  }
  if (n < 0) {
    throw new ProtocolError(`Chain swap field '${field}' is negative`, 'BTC', 'BAD_AMOUNT')
  }
  if (n > Number.MAX_SAFE_INTEGER) {
    throw new ProtocolError(`Chain swap field '${field}' exceeds safe integer precision`, 'BTC', 'BAD_AMOUNT')
  }
  return n
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
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
   * 26589) — the same derivation the maker's restore endpoint expects, so a
   * wallet restored from this mnemonic can recover swaps it no longer has
   * records for.
   */
  mnemonic: string
  /** Esplora override for the Bitcoin side. Omit to use the SDK's network default. */
  bitcoinEsploraUrl?: string
  /** Esplora override for the Liquid side. Omit to use the SDK's network default. */
  liquidEsploraUrl?: string
  /** Fee rate for claim/refund transactions, sat/vB. */
  feeSatPerVb?: number
  /**
   * Blocks of headroom required between the chain tip and the claim timeout.
   * Defaults follow the reference Boltz clients: 2 on Bitcoin, 10 on Liquid,
   * whose faster blocks make a late claim likelier to lose the race.
   */
  claimTimeoutMarginBlocks?: { bitcoin?: number; liquid?: number }
}

const DEFAULT_TIMEOUT_MARGIN_BLOCKS: Record<'bitcoin' | 'liquid', number> = {
  bitcoin: 2,
  liquid: 10,
}

export interface CreateChainSwapParams {
  fromLayer: Layer
  toLayer: Layer
  /** Sats to lock. Must sit within the pair's limits. */
  amountSat: number
  /** Wallet address on the destination chain that the claim pays out to. */
  destinationAddress: string
}

export class BoltzChainSwap {
  private master: SwapMasterKeyLike | null = null

  constructor(
    private config: BoltzChainSwapConfig,
    private store: BoltzChainSwapStore = BoltzChainSwapStore.fromPlatform()
  ) {}

  private masterKey(): SwapMasterKeyLike {
    if (this.master) return this.master
    const sdk = boltzSwapClientManager.getSdk()
    const { network } = boltzSwapClientManager.getConfig()
    this.master = sdk.SwapMasterKey.fromWalletMnemonic(this.config.mnemonic, network)
    return this.master
  }

  /**
   * The xpub to hand `swapRestore` when recovering swaps without local records.
   * Pass `"m"` as the derivation path — the API defaults to something else.
   */
  restoreXpub(): string {
    return this.masterKey().masterXpub()
  }

  /**
   * INDICATIVE quote from the maker's pair card. The binding numbers are the ones
   * in the `createSwap` result: the maker prices the swap when it creates it, and
   * this estimate is not a commitment either side is held to. Mirrors the SDK's
   * own fee helper (percentage on the locked amount, plus both user miner fees and
   * the server's), so it tracks the real figure closely enough to preview.
   *
   * `expiresAt` is 0 — there is no server-side quote to expire.
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
    const serviceFee = Math.ceil((percentage / 100) * amount)
    const claimFee = toSats(pair.fees?.minerFees?.user?.claim, 'minerFees.user.claim')
    const lockupFee = toSats(pair.fees?.minerFees?.user?.lockup, 'minerFees.user.lockup')
    const serverFee = toSats(pair.fees?.minerFees?.server, 'minerFees.server')
    const fee = serviceFee + claimFee + lockupFee + serverFee

    const rate = Number(pair.rate)
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new ProtocolError('Chain pair rate is not a valid number', 'BTC', 'BAD_AMOUNT')
    }
    const toAmount = Math.floor(amount * rate) - fee
    if (toAmount <= 0) {
      throw new ProtocolError(
        `Fees (${fee} sat) exceed the swap amount (${amount} sat)`,
        'BTC',
        'AMOUNT_TOO_SMALL'
      )
    }

    return {
      id: pair.hash,
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
   * that makes the funds recoverable always exists by the time the caller can act
   * on the lockup address.
   *
   * Nothing is spent here. Fund `record.lockupAddress` with exactly
   * `record.userLockAmount` in a single output, then call `markLockupFunded`.
   */
  async createSwap(params: CreateChainSwapParams): Promise<BoltzChainSwapRecord> {
    const from = assetForLayer(params.fromLayer)
    const to = assetForLayer(params.toLayer)
    if (from === to) {
      throw new ProtocolError('Chain swap requires two different chains', 'BTC', 'NOT_SUPPORTED')
    }
    if (!Number.isSafeInteger(params.amountSat) || params.amountSat <= 0) {
      throw new ProtocolError('Chain swap requires a positive integer sat amount', 'BTC', 'NO_AMOUNT')
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
    const now = Date.now()
    const record: BoltzChainSwapRecord = {
      swapId: requireString(response?.id, 'id'),
      index,
      from,
      to,
      userLockAmount: toSats(response?.lockupDetails?.amount, 'lockupDetails.amount'),
      serverLockAmount: toSats(response?.claimDetails?.amount, 'claimDetails.amount'),
      claimTimeoutBlockHeight: toSats(
        response?.claimDetails?.timeoutBlockHeight,
        'claimDetails.timeoutBlockHeight'
      ),
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
   * Record the lockup funding transaction. Call this as soon as the send is
   * broadcast — from here on the swap has funds at risk and must reach a claim or
   * a refund.
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
   * Poll the maker and advance the local phase. Safe to call on a host alarm/timer;
   * this is the reconciliation path that replaces the SDK's WebSocket stream, which
   * an evicted service worker would silently drop.
   */
  async sync(swapId: string): Promise<BoltzChainSwapRecord> {
    const record = await this.require(swapId)
    const client = boltzSwapClientManager.getClient()
    const raw = (await client.swap(swapId)) as { status?: unknown }
    const status = typeof raw?.status === 'string' ? raw.status : undefined
    const updated: BoltzChainSwapRecord = {
      ...record,
      status,
      // The maker can only spend our lockup with the preimage, so this status is
      // proof the secret is public — it unlocks the claim guards rather than
      // advancing the phase.
      userLockupSpent: record.userLockupSpent || status === 'transaction.claimed',
      phase: nextPhase(record.phase, status),
      updatedAt: Date.now(),
    }
    await this.store.put(updated)
    return updated
  }

  /**
   * Claim the maker's lockup to `destinationAddress`.
   *
   * Refuses unless the maker's lockup is CONFIRMED. A claim is the one
   * irreversible disclosure in the protocol — it publishes the preimage, which is
   * the only thing stopping the maker from taking our lockup. Spending that
   * secret against an unconfirmed transaction that can still be replaced is a
   * one-sided bet, so `server_locking` is not a claimable phase.
   *
   * Also refuses within `claimTimeoutMarginBlocks` of the claim timeout, where our
   * claim would race the maker's refund — unless the maker already spent our
   * lockup, which means the preimage is public anyway and claiming late is
   * strictly better than not claiming.
   *
   * Chain-swap claims take the non-cooperative script path: the cooperative MuSig2
   * keyspend needs a partial signature exchange the SDK's params object cannot
   * express. It is cheaper, and worth having once the SDK supports it.
   */
  async claim(swapId: string): Promise<BoltzChainSwapRecord> {
    const record = await this.require(swapId)
    if (record.phase === 'claimed') return record
    await this.assertClaimable(record)
    const script = this.buildScript(record, 'claim')
    const master = this.masterKey()
    const key = master.deriveSwapKey(BigInt(record.index))
    const preimage = master.derivePreimage(BigInt(record.index))
    const tx = await script.constructClaim(preimage.preimage, {
      ...this.txParams(record, key.secretKey),
      cooperative: false,
    })
    const claimTxid = await tx.broadcast(
      boltzSwapClientManager.getConfig().network,
      this.config.bitcoinEsploraUrl ?? null,
      this.config.liquidEsploraUrl ?? null,
      null
    )
    const updated: BoltzChainSwapRecord = {
      ...record,
      phase: 'claimed',
      claimTxid,
      updatedAt: Date.now(),
    }
    await this.store.put(updated)
    return updated
  }

  /**
   * Refund our own lockup back to `destinationAddress` after the swap failed or
   * expired. Fails until the lockup timelock has passed — that is the maker
   * enforcing the timeout, not a bug.
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
    const refundTxid = await tx.broadcast(
      boltzSwapClientManager.getConfig().network,
      this.config.bitcoinEsploraUrl ?? null,
      this.config.liquidEsploraUrl ?? null,
      null
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
   * Swaps that still owe an action — the work list for a host's resume-on-unlock
   * pass. Excludes swaps that are settled or that expired before we funded them.
   */
  async listPending(): Promise<BoltzChainSwapRecord[]> {
    const records = await this.store.list()
    return records.filter(
      (r) => r.phase !== 'claimed' && r.phase !== 'refunded' && r.phase !== 'failed'
    )
  }

  /**
   * Gate on the two conditions that make a claim safe to broadcast: the maker's
   * lockup is confirmed, and the claim timeout is far enough away that our
   * transaction can land before the maker may reclaim.
   *
   * Both are waived once `userLockupSpent` is set — at that point the preimage is
   * already public, so neither caution buys anything.
   */
  private async assertClaimable(record: BoltzChainSwapRecord): Promise<void> {
    if (record.userLockupSpent) return

    if (record.phase !== 'server_locked') {
      throw new ProtocolError(
        record.phase === 'server_locking'
          ? `Maker lockup for swap '${record.swapId}' is unconfirmed — claiming now would reveal the preimage against a replaceable transaction`
          : `Swap '${record.swapId}' is not claimable in phase '${record.phase}'`,
        'BTC',
        'NOT_CLAIMABLE'
      )
    }

    const chainKind = ASSET_CHAIN_KIND[record.to]
    const margin =
      this.config.claimTimeoutMarginBlocks?.[chainKind] ?? DEFAULT_TIMEOUT_MARGIN_BLOCKS[chainKind]
    const heights = (await boltzSwapClientManager.getClient().height()) as Record<string, unknown>
    const tip = toSats(heights?.[record.to], `height.${record.to}`)
    if (tip > record.claimTimeoutBlockHeight - margin) {
      throw new ProtocolError(
        `Claim window for swap '${record.swapId}' has closed: ${chainKind} tip ${tip} is within ${margin} blocks of the timeout at ${record.claimTimeoutBlockHeight}`,
        'BTC',
        'CLAIM_WINDOW_CLOSED'
      )
    }
  }

  private async require(swapId: string): Promise<BoltzChainSwapRecord> {
    const record = await this.store.get(swapId)
    if (!record) {
      throw new ProtocolError(`Unknown chain swap '${swapId}'`, 'BTC', 'NOT_FOUND')
    }
    return record
  }

  /**
   * Rebuild the swap script from the stored create response. `side` selects which
   * half: 'claim' is the maker's lockup on the destination chain, 'lockup' is ours
   * on the source chain.
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
      boltzBaseUrl: resolveBoltzBaseUrl(boltzSwapClientManager.getConfig()),
      network: boltzSwapClientManager.getConfig().network,
      bitcoinEsploraUrl: this.config.bitcoinEsploraUrl,
      liquidEsploraUrl: this.config.liquidEsploraUrl,
      feeSatPerVb: this.config.feeSatPerVb,
    }
  }
}

/**
 * Fold a maker status into the local phase.
 *
 * Locally-terminal phases win: once we have broadcast a claim or a refund, a
 * server status cannot walk the record backwards. Unknown statuses leave the
 * phase untouched — never infer progress from a state we do not model.
 *
 * `transaction.claimed` means the SERVER claimed OUR lockup, which it can only do
 * after our claim revealed the preimage; it is not our claim completing, so it
 * does not set 'claimed'.
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
