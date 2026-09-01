/**
 * Flashnet Client Manager — singleton for a FlashnetClient from `@flashnet/sdk`.
 * Requires an initialized SparkWallet. The SDK is a value import (optional
 * dependency), matching the Spark client-manager convention.
 */

import type { SparkWallet } from '@buildonspark/spark-sdk'
import { FlashnetClient, type WalletBalance } from '@flashnet/sdk'
import {
  BTC_ASSET_PUBKEY,
  USDB_DECIMALS,
  getFlashnetNetworkForSpark,
  getFlashnetUsdbTokenAddress,
  isUsdbTokenAddress,
  type FlashnetNetwork,
} from '../types/flashnet'
import { log } from './log'
import { normalizeTxHash, saveSentTokenRecord } from './spark-sent-token-records'
import { txHashFromBytes, u8aToHex } from './spark-helpers'
import type { SparkConfig } from '../types/spark'
import { WalletSessionGuard, type SessionAttempt } from './wallet-session'

/**
 * Normalize the SDK pools response to an array: it may return `Pool[]` or
 * `{ pools: Pool[] }`.
 */
function normalizePoolsResponse(response: unknown): unknown[] {
  if (Array.isArray(response)) return response
  if (
    response &&
    typeof response === 'object' &&
    Array.isArray((response as { pools?: unknown[] }).pools)
  ) {
    return (response as { pools: unknown[] }).pools
  }
  return []
}

/** The guard's single slot: the FlashnetClient handshake. */
const CLIENT_SLOT = 'client'

class FlashnetClientManager {
  private client: FlashnetClient | null = null
  /**
   * Wallet identity + generation guard, shared with the other client managers.
   * The wallet key is the `SparkWallet` instance itself, recorded from the
   * moment the attempt starts: returning wallet A's in-flight promise to wallet
   * B's caller would silently drop B's init and leave the Flashnet client bound
   * to A's SparkWallet (and A's keys) inside B's session (findings A-F8/N5).
   * See src/lib/wallet-session.ts.
   */
  private readonly session = new WalletSessionGuard({ name: 'FlashnetClientManager' })
  private poolId: string | null = null
  private network: FlashnetNetwork | null = null

  initialize(wallet: SparkWallet, sparkNetwork?: SparkConfig['network']): Promise<void> {
    return this.session.begin(CLIENT_SLOT, wallet, (attempt) =>
      this.doInitialize(wallet, sparkNetwork, attempt),
    )
  }

  private async doInitialize(
    wallet: SparkWallet,
    sparkNetwork: SparkConfig['network'] | undefined,
    attempt: SessionAttempt,
  ): Promise<void> {
    if (this.client) {
      await this.disconnect()
    }

    // Marked AFTER the re-init disconnect above, which invalidates the session itself.
    attempt.mark()
    const network = getFlashnetNetworkForSpark(sparkNetwork)
    if (!network) {
      throw new Error('Flashnet is only available when Spark is on mainnet or regtest.')
    }

    try {
      // The SDK accepts SparkWallet | IssuerSparkWallet but doesn't export a
      // shared base — the cast keeps the call site honest while letting the
      // rest of the file enjoy real types from the SDK.
      const client = new FlashnetClient(wallet as never)
      await client.initialize()

      // A disconnect()/wallet switch landed while the SDK init was pending. This
      // client is bound to the previous wallet; installing it now would undo the
      // teardown and put the next session on the previous wallet's keys.
      if (!(await attempt.claim(() => client.cleanup()))) return

      this.client = client
      this.network = network

      try {
        const poolsResponse = await this.client.listPools({
          assetAAddress: BTC_ASSET_PUBKEY,
          assetBAddress: getFlashnetUsdbTokenAddress(network),
          sort: 'TVL_DESC',
        })
        const pools = normalizePoolsResponse(poolsResponse)
        if (pools && pools.length > 0) {
          // listPools returns LpPublicKey identifiers; we store the first
          // (highest-TVL) BTC↔USDB pool as the default for swap UX.
          const first = pools[0] as { lpPublicKey?: string }
          if (first?.lpPublicKey) this.poolId = first.lpPublicKey
        }
      } catch (error) {
        log.warn('[FlashnetClientManager] Pool discovery failed:', error)
      }

      // Backfill outgoing-swap history into the sent-token outbox so past token
      // swaps appear as sends. Flashnet nominates hashes, but the Spark operator
      // must independently prove each one spent this wallet's token outputs.
      // Best-effort and async: never blocks wallet init.
      void this.backfillSwapHistory(wallet)
    } catch (error) {
      // Only clear state if this init still owns the session; a stale failure
      // must not tear down a newer, successful one.
      if (attempt.isCurrent) {
        this.client = null
        this.poolId = null
        this.network = null
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to initialize FlashnetClient: ${message}`)
    }
  }

  /**
   * Fetch the wallet's AMM swap history and persist the outgoing (token-in) legs to
   * the sent-token outbox.
   *
   * A swap moves a token to the pool via an internal SDK transfer the Spark
   * token-transaction query cannot classify as a send, while Flashnet's
   * `GET /v1/swaps/user/{pubkey}` returns every swap with explicit direction — so
   * this fixes future swaps and recovers ones predating any recording.
   *
   * Idempotent: records are keyed by transfer hash.
   */
  private async backfillSwapHistory(wallet: SparkWallet): Promise<void> {
    const client = this.client
    if (!client) return

    // `toHumanReadableTokenIdentifier` is private on FlashnetClient; the swap
    // endpoint may return hex token ids, so normalize to the bech32 form the
    // rest of the wallet uses when possible.
    const toHumanReadable = (raw: string): string => {
      try {
        const fn = (client as unknown as { toHumanReadableTokenIdentifier?(id: string): string })
          .toHumanReadableTokenIdentifier
        return fn ? fn.call(client, raw) : raw
      } catch {
        return raw
      }
    }

    try {
      const senderSparkAddress = (await wallet.getSparkAddress()) as string
      const { swaps } = await client.getUserSwaps(undefined, {
        sort: 'timestampDesc',
        limit: 200,
      })

      const candidates = (swaps ?? []).filter((swap) => {
        const assetIn = swap?.assetInAddress
        return !!assetIn && assetIn !== BTC_ASSET_PUBKEY && !!swap?.inboundTransferId
      })
      if (candidates.length === 0) return

      const candidateHashes = candidates.map((swap) => normalizeTxHash(swap.inboundTransferId))
      const candidateResponse = await wallet.queryTokenTransactionsByTxHashes(candidateHashes)
      const candidateTransactions = new Map<string, any>()
      for (const row of candidateResponse?.tokenTransactionsWithStatus ?? []) {
        const hash = row?.tokenTransactionHash
        if (hash instanceof Uint8Array) candidateTransactions.set(txHashFromBytes(hash), row)
      }

      const previousHashes = new Set<string>()
      for (const row of candidateTransactions.values()) {
        const transferInput = row?.tokenTransaction?.tokenInputs?.transferInput
        for (const input of transferInput?.outputsToSpend ?? []) {
          if (input?.prevTokenTransactionHash instanceof Uint8Array) {
            previousHashes.add(txHashFromBytes(input.prevTokenTransactionHash))
          }
        }
      }
      if (previousHashes.size === 0) return

      const previousResponse = await wallet.queryTokenTransactionsByTxHashes([...previousHashes])
      const previousTransactions = new Map<string, any>()
      for (const row of previousResponse?.tokenTransactionsWithStatus ?? []) {
        const hash = row?.tokenTransactionHash
        if (hash instanceof Uint8Array) previousTransactions.set(txHashFromBytes(hash), row)
      }
      const walletIdentity = normalizeTxHash(await wallet.getIdentityPublicKey())

      let recorded = 0
      for (const swap of candidates) {
        // Only the token-in leg is an outflow that needs the outbox. The
        // token-out leg of a swap is a receive, already returned by the
        // Spark token-transaction query.
        const assetIn = swap?.assetInAddress
        const inboundTransferId = swap?.inboundTransferId
        if (!assetIn || !inboundTransferId) continue

        const candidate = candidateTransactions.get(normalizeTxHash(inboundTransferId))
        const inputs = candidate?.tokenTransaction?.tokenInputs?.transferInput?.outputsToSpend
        if (!Array.isArray(inputs) || inputs.length === 0) continue
        const spendsOnlyWalletOutputs = inputs.every((input: any) => {
          if (!(input?.prevTokenTransactionHash instanceof Uint8Array)) return false
          const previous = previousTransactions.get(txHashFromBytes(input.prevTokenTransactionHash))
          const output = previous?.tokenTransaction?.tokenOutputs?.[input.prevTokenTransactionVout]
          return output?.ownerPublicKey instanceof Uint8Array &&
            normalizeTxHash(u8aToHex(output.ownerPublicKey)) === walletIdentity
        })
        if (!spendsOnlyWalletOutputs) continue

        const assetId = toHumanReadable(assetIn)
        const isUsdb = isUsdbTokenAddress(assetId)
        const parsedTs = Date.parse(swap?.timestamp ?? '')

        await saveSentTokenRecord({
          hash: inboundTransferId,
          senderSparkAddress,
          amount: Number(swap?.amountIn ?? 0) || 0,
          assetId,
          ticker: isUsdb ? 'USDB' : 'TOKEN',
          name: isUsdb ? 'USDB' : assetId,
          decimals: isUsdb ? USDB_DECIMALS : 0,
          timestamp: Number.isFinite(parsedTs) ? parsedTs : Date.now(),
        })
        recorded += 1
      }

      if (recorded > 0) {
        log.info(
          `[FlashnetClientManager] Backfilled ${recorded} outgoing swap(s) into token history`,
        )
      }
    } catch (error) {
      log.warn('[FlashnetClientManager] Swap history backfill failed:', error)
    }
  }

  getClient(): FlashnetClient {
    if (!this.client) {
      throw new Error('FlashnetClient not initialized. Call initialize() first.')
    }
    return this.client
  }

  /** Convenience pass-through so callers don't need to await client.getBalance() through a cast. */
  async getBalance(): Promise<WalletBalance> {
    return this.getClient().getBalance()
  }

  getPoolId(): string | null {
    return this.poolId
  }

  getNetwork(): FlashnetNetwork | null {
    return this.network
  }

  getUsdbTokenAddress(): string {
    if (!this.network) {
      throw new Error('Flashnet network unavailable. Initialize the client first.')
    }
    return getFlashnetUsdbTokenAddress(this.network)
  }

  isInitialized(): boolean {
    return this.client !== null
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.cleanup()
      } catch (error) {
        log.warn('[FlashnetClientManager] Disconnect error:', error)
      }
    }
    this.client = null
    this.poolId = null
    this.network = null
    this.session.invalidate()
  }
}

export const flashnetClientManager = new FlashnetClientManager()
