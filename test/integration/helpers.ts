/**
 * Integration-test helpers: thin wrappers that build + connect each WDK adapter for
 * a given wallet on its target test network, plus shared assertions. All connect
 * config comes from `config.ts`.
 */

import { expect, type TestContext } from 'vitest'
import type { IProtocolAdapter } from '../../src/adapters/IProtocolAdapter'
import { SparkWdkAdapter } from '../../src/adapters/wdk/SparkWdkAdapter'
import { LiquidWdkAdapter } from '../../src/adapters/wdk/LiquidWdkAdapter'
import { ArkadeWdkAdapter } from '../../src/adapters/wdk/ArkadeWdkAdapter'
import { RgbLibWdkAdapter } from '../../src/adapters/wdk/RgbLibWdkAdapter'
import {
  ARKADE,
  LIQUID,
  REQUIRE_FUNDED_WALLETS,
  REQUIRE_LIVE_ENDPOINTS,
  RETURN_TEST_FUNDS,
  RGB_L1,
  SPARK,
  rgbDataDir,
  type WalletFixture,
} from './config'

/**
 * Retry a flaky async factory with backoff. The Spark regtest server intermittently
 * drops its gRPC channel during wallet init; a fresh attempt almost always
 * succeeds. Generic so other public-endpoint suites can reuse it.
 */
export async function withRetry<T>(
  label: string,
  factory: () => Promise<T>,
  { attempts = 3, baseDelayMs = 2000 }: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await factory()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) {
        // eslint-disable-next-line no-console
        console.warn(`[integration] ${label} attempt ${i + 1}/${attempts} failed, retrying: ${String(err)}`)
        await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)))
      }
    }
  }
  throw lastErr
}

/** Connect a Spark (regtest) adapter for the given wallet. */
export async function connectSpark(wallet: WalletFixture): Promise<SparkWdkAdapter> {
  // Spark's gRPC channel is flaky on connect; rebuild the adapter per attempt.
  return withRetry(`connectSpark(${wallet.name})`, async () => {
    const adapter = new SparkWdkAdapter()
    try {
      await adapter.connect({
        protocol: 'SPARK',
        network: SPARK.network,
        mnemonic: wallet.mnemonic!,
      } as any)
      return adapter
    } catch (err) {
      await safeDisconnect(adapter)
      throw err
    }
  })
}

/** Connect a Liquid (testnet) adapter for the given wallet. */
export async function connectLiquid(wallet: WalletFixture): Promise<LiquidWdkAdapter> {
  // The gap-limit scan against the public esplora is rate-limited, which trips
  // lwk's browser-only backoff sleep under Node; retry so a transient rate-limit
  // doesn't fail the suite. LIQUID_WATERFALLS=1 avoids the multi-request scan.
  return withRetry(`connectLiquid(${wallet.name})`, async () => {
    const adapter = new LiquidWdkAdapter()
    try {
      await adapter.connect({
        protocol: 'LIQUID',
        network: LIQUID.network,
        mnemonic: wallet.mnemonic!,
        esploraUrl: LIQUID.esploraUrl,
        waterfalls: LIQUID.waterfalls,
        // Live tests deliberately opt in so a Waterfalls outage exercises the
        // published standard-Esplora recovery path instead of failing the suite.
        allowDefaultEsploraFallback: LIQUID.waterfalls,
      } as any)
      return adapter
    } catch (err) {
      await safeDisconnect(adapter)
      throw err
    }
  })
}

/** Connect an Arkade (mutinynet/signet) adapter for the given wallet. */
export async function connectArkade(wallet: WalletFixture): Promise<ArkadeWdkAdapter> {
  const adapter = new ArkadeWdkAdapter()
  await adapter.connect({
    protocol: 'ARKADE',
    network: ARKADE.network,
    mnemonic: wallet.mnemonic!,
    arkServerUrl: ARKADE.arkServerUrl,
    esploraUrl: ARKADE.esploraUrl,
    delegatorUrl: ARKADE.delegatorUrl,
  } as any)
  return adapter
}

/**
 * Connect a local rgb-lib (RGB_L1, mutinynet/signet) adapter for the given wallet.
 *
 * Retried like Spark and Liquid: `goOnline` syncs the wallet on connect and both
 * Alice and Bob do it, which makes this the suite's heaviest burst at the
 * indexer and the first thing a rate limit refuses.
 */
export async function connectRgbL1(wallet: WalletFixture): Promise<RgbLibWdkAdapter> {
  return withRetry(`connectRgbL1(${wallet.name})`, async () => {
    const adapter = new RgbLibWdkAdapter()
    await adapter.connect({
      protocol: 'RGB_L1',
      network: RGB_L1.network,
      mnemonic: wallet.mnemonic!,
      dataDir: rgbDataDir(wallet),
      indexerUrl: RGB_L1.indexerUrl,
      transportEndpoint: RGB_L1.transportEndpoint,
    } as any)
    return adapter
  })
}

/** Best-effort disconnect; never throws (used in afterAll cleanup). */
export async function safeDisconnect(adapter: IProtocolAdapter | undefined): Promise<void> {
  try {
    await adapter?.disconnect()
  } catch {
    /* teardown must not fail the suite */
  }
}

/**
 * Assert a wallet is funded: total BTC-equivalent balance is positive and finite.
 * Surfaces the actual balance in the failure message.
 */
export function assertFunded(label: string, balance: { total: number }): void {
  expect(Number.isFinite(balance.total), `${label} balance should be a finite number`).toBe(true)
  expect(balance.total, `${label} should be funded (total > 0) on its test network`).toBeGreaterThan(0)
}

/**
 * A small send amount, or skip when the wallet cannot cover one.
 *
 * These wallets drain, and a drained one is a funding fact rather than a
 * regression — failing on it left `Live integration` permanently red, which is
 * the same as having no check (#77). `REQUIRE_FUNDED_WALLETS=1` fails instead.
 * Takes the test's context so the skip lands on the test, not the file.
 */
export function spendableSend(
  ctx: TestContext,
  total: number,
  label: string,
  target = 100,
  feeBuffer = 200,
): number {
  const needed = target + feeBuffer
  if (total > needed) return target

  const shortfall = `${label}: needs > ${needed} sat spendable to exercise the send test (has ${total}) — top up the wallet`
  if (REQUIRE_FUNDED_WALLETS) {
    expect(total, shortfall).toBeGreaterThan(needed)
  }
  // Printed as well as attached to the skip: a skip reason is easy to miss in a
  // 26-test report, and the next person needs one line, not an archaeology dig.
  console.warn(`⚠ SKIPPED — ${shortfall}`)
  ctx.skip(shortfall)
  // `ctx.skip()` aborts, so this is unreachable; it exists so the signature
  // stays `number` and no call site has to handle a null it can never see.
  return target
}


/**
 * A thrown value's message, following the `cause` chain — the outer message is
 * usually the useless half. `@utexo/rgb-sdk` reports every `goOnline` failure
 * as "Failed to establish online connection" and hangs the real reason off
 * `cause`, so printing only the message reports an outage whatever the truth.
 */
function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error === 'string' ? error : JSON.stringify(error)
  const chain: string[] = []
  let current: unknown = error
  // Bounded: a cause chain is short, and a cyclic one must not hang the suite.
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current.message && !chain.includes(current.message)) chain.push(current.message)
    current = current.cause
  }
  if (current !== undefined && !(current instanceof Error)) {
    const tail = typeof current === 'string' ? current : JSON.stringify(current)
    if (tail && !chain.includes(tail)) chain.push(tail)
  }
  return chain.join(' ← ')
}

/** `messageOf` for call sites outside this module (the address printer). */
export const describeError = messageOf

/**
 * Run a suite's setup, returning the reason it could not connect rather than
 * throwing — an unreachable public endpoint reads as "adapter broken" and no
 * diff can clear it. `REQUIRE_LIVE_ENDPOINTS=1` rethrows. Only setup is
 * covered; an error inside a test is still a failure.
 */
export async function liveSetup(label: string, connect: () => Promise<void>): Promise<string | undefined> {
  try {
    await connect()
    return undefined
  } catch (error) {
    if (REQUIRE_LIVE_ENDPOINTS) throw error
    const reason = `${label} is unreachable — ${messageOf(error)}`
    console.warn(`⚠ SKIPPED — ${reason}`)
    return reason
  }
}

/**
 * Skip a test whose suite never connected. Pass the reason `liveSetup`
 * returned; `undefined` means the setup worked and the test runs.
 *
 * Called from `beforeEach` so the skip lands on each test individually and the
 * file still reports how many tests the outage cost.
 */
export function skipWhenUnavailable(ctx: TestContext, reason: string | undefined): void {
  if (reason) ctx.skip(reason)
}

/**
 * Coin selection cannot cover a send. Each protocol words it differently:
 * rgb-lib's `InsufficientAssignments` is the same fact as Arkade's VTXOs
 * failing to assemble.
 */
const INSUFFICIENT_FUNDS =
  /insufficient\s?(funds|balance|assignments|allocationslots|allocation slots)|not enough/i

/**
 * A recipient id already used against the transport proxy. Not a resource
 * shortfall and it never clears: the proxy keeps `recipient id → consignment`
 * indefinitely, and a witness id derives from the keychain with no outpoint to
 * vary it, so an ephemeral database regenerates the same one every run.
 * Witness receive verifies once per (wallet, proxy). See the README.
 */
const RECIPIENT_ID_REUSED = /RecipientIDAlreadyUsed/i

/**
 * Send, skipping when the wallet turns out not to afford it after all.
 *
 * A reported balance and what coin selection can assemble are different
 * numbers — VTXO granularity, preconfirmed outputs and the real fee are
 * invisible in a total — so the SDK's own refusal is treated as the fact the
 * precondition was guarding against. `REQUIRE_FUNDED_WALLETS=1` fails instead.
 */
export async function sendOrSkip<T>(ctx: TestContext, label: string, send: () => Promise<T>): Promise<T> {
  try {
    return await send()
  } catch (error) {
    const message = messageOf(error)
    if (RECIPIENT_ID_REUSED.test(message) && !REQUIRE_FUNDED_WALLETS) {
      const reason = `${label}: this wallet's witness recipient id was already used against the transport proxy, and the proxy keeps them — an ephemeral rgb-lib database regenerates the same id every run, so witness receive verifies once per wallet and then always reports this`
      console.warn(`⚠ SKIPPED — ${reason}`)
      ctx.skip(reason)
      throw error
    }
    if (REQUIRE_FUNDED_WALLETS || !INSUFFICIENT_FUNDS.test(message)) throw error
    const reason = `${label}: the wallet reported enough but coin selection could not cover the send — ${message}`
    console.warn(`⚠ SKIPPED — ${reason}`)
    ctx.skip(reason)
    // Unreachable: `ctx.skip()` aborts the test.
    throw error
  }
}

/**
 * Send a test amount back in teardown, so a run costs two fees instead of a
 * wallet — the send tests only ever run one way, so one wallet drained.
 * Never throws: a failed return is a funding fact for the next run.
 */
export async function returnFunds(label: string, send: () => Promise<unknown>): Promise<void> {
  if (!RETURN_TEST_FUNDS) return
  try {
    await send()
    console.log(`\u21a9 returned — ${label}`)
  } catch (error) {
    console.warn(`\u21a9 return leg did not go through (not a test failure) — ${label}: ${messageOf(error)}`)
  }
}

/**
 * Ensure `want` colorable UTXOs with no allocation, and wait until they are
 * usable — `createRgbUtxos` broadcasts a transaction whose outputs do not
 * exist until it confirms. Returns what it got, so a caller skips on a real
 * number. One allocation per UTXO here: a sender needs two (asset + change),
 * a blinded recipient one, a witness recipient none.
 */
export async function ensureColorableSlots(
  wallet: {
    countFreeColorableSlots?: () => Promise<number>
    createRgbUtxos?: (p: { num?: number; upTo?: boolean }) => Promise<unknown>
    refreshBalances?: () => Promise<unknown>
  },
  want: number,
  label: string,
  { timeoutMs = 120_000, pollMs = 5_000 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<number> {
  const count = async (): Promise<number> => {
    try {
      await wallet.refreshBalances?.()
    } catch {
      /* a refresh that fails is not itself the answer; the count below is */
    }
    return (await wallet.countFreeColorableSlots?.()) ?? 0
  }

  let have = await count()
  if (have >= want) return have

  try {
    await wallet.createRgbUtxos?.({ num: want, upTo: true })
  } catch (error) {
    // `AllocationsAlreadyAvailable` is the postcondition met, stated as an
    // error. The poll below decides either way.
    if (!/AllocationsAlreadyAvailable/.test(describeError(error))) {
      console.warn(`[rgb] ${label}: createRgbUtxos(${want}) — ${describeError(error)}`)
    }
  }

  const deadline = Date.now() + timeoutMs
  while (have < want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs))
    have = await count()
  }
  console.log(`[rgb] ${label}: ${have}/${want} free colorable slot(s)`)
  return have
}

/** rgb-lib's transfer states. */
const TRANSFER_STATUS = ['WAITING_COUNTERPARTY', 'WAITING_CONFIRMATIONS', 'SETTLED'] as const

/**
 * Wait for a wallet's spendable balance of an asset to reach `want`. An RGB
 * send leaves the change unconfirmed, and settling takes BOTH sides —
 * `WAITING_COUNTERPARTY` only advances when the recipient refreshes — so
 * `refreshAlso` takes the counterparties and the poll drives all of them.
 */
export async function waitForSpendableAsset(
  wallet: {
    getAssetBalance?: (assetId: string) => Promise<{ available: number; total: number }>
    refreshBalances?: () => Promise<unknown>
    listTransfers?: (options?: { asset_id?: string }) => Promise<unknown>
  },
  assetId: string,
  want: number,
  label: string,
  {
    refreshAlso = [],
    timeoutMs = 180_000,
    pollMs = 10_000,
  }: {
    refreshAlso?: Array<{ refreshBalances?: () => Promise<unknown> }>
    timeoutMs?: number
    pollMs?: number
  } = {},
): Promise<number> {
  const refreshAll = async (): Promise<void> => {
    await Promise.allSettled(
      [wallet, ...refreshAlso].map((w) => Promise.resolve().then(() => w.refreshBalances?.())),
    )
  }

  const read = async (): Promise<number> => {
    await refreshAll()
    return (await wallet.getAssetBalance?.(assetId))?.available ?? 0
  }

  /** The transfer's state, so a timeout says where it stuck. */
  const statuses = async (): Promise<string> => {
    try {
      const transfers = (await wallet.listTransfers?.({ asset_id: assetId })) as
        | Array<{ status?: number }>
        | undefined
      if (!Array.isArray(transfers) || transfers.length === 0) return 'no transfers'
      return transfers
        .slice(-3)
        .map((t) => TRANSFER_STATUS[t?.status ?? -1] ?? `status ${t?.status}`)
        .join(', ')
    } catch {
      return 'status unavailable'
    }
  }

  let available = await read()
  if (available >= want) return available

  const deadline = Date.now() + timeoutMs
  console.log(`[rgb] ${label}: waiting for ${want} spendable of ${assetId} (have ${available}; ${await statuses()})`)
  while (available < want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs))
    available = await read()
  }
  console.log(`[rgb] ${label}: ${available} spendable after waiting (${await statuses()})`)
  return available
}
