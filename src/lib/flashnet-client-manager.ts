/**
 * Flashnet Client Manager
 * Singleton managing the lifecycle of a FlashnetClient from `@flashnet/sdk`.
 * Requires an initialized SparkWallet to function.
 *
 * Ported from rate-extension/src/protocols/spark/flashnet-client-manager.ts.
 * The SDK is a value import (optional dependency) — consumers install
 * `@flashnet/sdk` to use this manager, matching the Spark client-manager convention.
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
import { saveSentTokenRecord } from './spark-sent-token-records'
import type { SparkConfig } from '../types/spark'

/**
 * Normalize the SDK pools response to always return an array.
 * The SDK may return `Pool[]` or `{ pools: Pool[] }`.
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

class FlashnetClientManager {
  private client: FlashnetClient | null = null
  private initPromise: Promise<void> | null = null
  /**
   * The wallet the in-flight `initPromise` is for. Sharing an in-flight init is
   * only correct for the SAME wallet — returning wallet A's promise to wallet
   * B's caller silently drops B's init and leaves the Flashnet client bound to
   * A's SparkWallet (and A's keys) inside B's session.
   */
  private initWallet: SparkWallet | null = null
  /**
   * Bumped by every disconnect() and by a wallet switch. An in-flight
   * `doInitialize` captures it and refuses to install its client, network or
   * history backfill if it changed while the SDK init was pending.
   */
  private teardownGeneration = 0
  private poolId: string | null = null
  private network: FlashnetNetwork | null = null

  initialize(wallet: SparkWallet, sparkNetwork?: SparkConfig['network']): Promise<void> {
    // Same wallet → share the in-flight init, as before.
    if (this.initPromise && this.initWallet === wallet) return this.initPromise
    // Different wallet → the pending init belongs to someone else. Invalidate it
    // (the generation guard stops it installing) and start a fresh one.
    if (this.initPromise) this.teardownGeneration++
    this.initWallet = wallet
    const promise = this.doInitialize(wallet, sparkNetwork).finally(() => {
      // Only the newest init clears the slot; an older one settling later must
      // not wipe a newer in-flight init.
      if (this.initPromise === promise) {
        this.initPromise = null
        this.initWallet = null
      }
    })
    this.initPromise = promise
    return promise
  }

  private async doInitialize(
    wallet: SparkWallet,
    sparkNetwork?: SparkConfig['network'],
  ): Promise<void> {
    if (this.client) {
      await this.disconnect()
    }

    // Captured AFTER the re-init disconnect above, which bumps the counter itself.
    const generation = this.teardownGeneration
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
      if (generation !== this.teardownGeneration) {
        log.info('[FlashnetClientManager] Init superseded by teardown — discarding client')
        try {
          await client.cleanup()
        } catch (cleanupError) {
          log.warn('[FlashnetClientManager] Error cleaning up superseded client:', cleanupError)
        }
        return
      }

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

      // Backfill outgoing-swap history into the sent-token outbox so past
      // token swaps (e.g. USDB → BTC) appear as sends in transaction history.
      // Flashnet's AMM swap endpoint is the authoritative, retroactive source
      // of direction — the Spark SDK exposes none for token transactions.
      // Best-effort and async: never blocks or fails wallet init.
      void this.backfillSwapHistory(wallet)
    } catch (error) {
      // Only clear state if this init still owns the session; a stale failure
      // must not tear down a newer, successful one.
      if (generation === this.teardownGeneration) {
        this.client = null
        this.poolId = null
        this.network = null
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to initialize FlashnetClient: ${message}`)
    }
  }

  /**
   * Fetch the wallet's AMM swap history and persist the outgoing (token-in)
   * legs to the sent-token outbox.
   *
   * A swap moves a token to the pool via an internal SDK transfer that the
   * Spark token-transaction query cannot classify as a send. Flashnet's
   * `GET /v1/swaps/user/{pubkey}` returns every past swap with explicit
   * direction (assetIn / amountIn / inboundTransferId), so this both fixes
   * future swaps and recovers ones made before any recording existed.
   *
   * Idempotent — records are keyed by transfer hash, so re-running on each
   * connect simply refreshes them.
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

      let recorded = 0
      for (const swap of swaps ?? []) {
        // Only the token-in leg is an outflow that needs the outbox. The
        // token-out leg of a swap is a receive, already returned by the
        // Spark token-transaction query.
        const assetIn = swap?.assetInAddress
        const inboundTransferId = swap?.inboundTransferId
        if (!assetIn || assetIn === BTC_ASSET_PUBKEY || !inboundTransferId) continue

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
    this.initPromise = null
    this.initWallet = null
    this.teardownGeneration++
  }
}

export const flashnetClientManager = new FlashnetClientManager()
