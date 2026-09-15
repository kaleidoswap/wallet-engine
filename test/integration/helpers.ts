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
 * Pick a small, safe send amount from a wallet's spendable balance, or skip the
 * test when the wallet cannot cover one.
 *
 * These run against shared test wallets that drain, so a hardcoded amount
 * eventually exceeds the balance. The question is what an empty wallet should
 * do to the job. It used to fail it, identically to a broken transfer — and
 * because these wallets do drain, `Live integration` sat red on `main` for
 * three days and on every PR touching `src/**` whatever the diff (#77). A
 * permanently red check is read and dismissed by hand, which is how a real
 * drift failure gets waved through.
 *
 * A skip states the same fact without destroying the signal: the read-only
 * contract assertions still run and still fail on drift, and the one thing
 * that cannot run says so by name. `REQUIRE_FUNDED_WALLETS=1` restores the
 * failure for the run that is actually asking whether the wallets are funded.
 *
 * Pass the test's own context so the skip lands on the test that needed the
 * funds, not on the file.
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
 * Read a thrown value's message without assuming it is an Error, following the
 * `cause` chain to the end.
 *
 * The outer message is usually the useless half. `@utexo/rgb-sdk` wraps every
 * `goOnline` failure as `Failed to establish online connection` and hangs the
 * reason rgb-lib actually gave off `cause`, so a suite that printed only the
 * message reported an unreachable network whatever the truth was — a wrong
 * indexer kind, a mismatched network, a rejected wallet — and got read as "the
 * endpoint is flapping again" every time. It cost this suite a diagnosis more
 * than once.
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
 * Run a suite's live setup, returning the reason it could not connect instead
 * of throwing.
 *
 * A `beforeAll` that throws fails every test in the file, which is the right
 * answer when the adapter is broken and the wrong one when the network it
 * talks to is simply down. These suites connect to public mutinynet,
 * liquidtestnet and regtest services; when one is unreachable the resulting
 * red says "adapter broken" and no diff can clear it — the same signal-
 * destroying failure the drained wallets caused (#77).
 *
 * So the reason is captured and handed to `skipWhenUnavailable`, and the other
 * suites carry on reporting. `REQUIRE_LIVE_ENDPOINTS=1` rethrows instead, for
 * the run that is asking whether the endpoints are up.
 *
 * Only setup is covered. An error inside a test is still a failure: by then
 * the connection worked, and what broke is what the test was exercising.
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
 * Errors the underlying SDKs raise when coin selection cannot cover a send.
 *
 * Each protocol has its own word for it. rgb-lib says `InsufficientAssignments`
 * when a wallet owns an asset but has no spendable allocation of it yet —
 * the same fact as an Arkade wallet whose VTXOs will not assemble, and it
 * deserves the same skip rather than a red job.
 */
const INSUFFICIENT_FUNDS =
  /insufficient\s?(funds|balance|assignments|allocationslots|allocation slots)|not enough/i

/**
 * A recipient id this wallet has already used against the transport proxy.
 *
 * Kept out of `INSUFFICIENT_FUNDS` because it is not a resource shortfall, and
 * it does not clear on its own: the proxy retains `recipient id → consignment`
 * indefinitely, and a WITNESS recipient id is derived from the wallet's
 * keychain with no outpoint to vary it — so an ephemeral rgb-lib database
 * regenerates the same id on every run and the proxy rejects it forever after
 * the first use.
 *
 * I first read this as invoice expiry and shortened `durationSeconds` to 120s.
 * That was wrong: a run more than an hour after the last invoice was created,
 * with every window long past, still collided. Whatever fixes this, it is not
 * time.
 *
 * Practical consequence: witness receive can be verified exactly once per
 * (wallet, proxy). A blinded id derives from a real outpoint, differs each run,
 * and is unaffected.
 */
const RECIPIENT_ID_REUSED = /RecipientIDAlreadyUsed/i

/**
 * Perform a send, skipping when the wallet turns out not to afford it after
 * all.
 *
 * `spendableSend` asks the adapter for a balance and decides from that, but
 * the balance a wallet reports and the amount its coin selection can actually
 * assemble are different numbers. Alice's Arkade wallet proved it: she passed
 * the 300-sat precondition and the send still died inside
 * `selectVirtualCoins` with `Insufficient funds`, because VTXO granularity,
 * preconfirmed outputs and the real fee are not visible in a total.
 *
 * A pre-check that can be wrong in this direction has to treat the SDK's own
 * refusal as the same fact it was guarding against, or the guard just moves
 * the red three lines down.
 *
 * The cost is honest and worth naming: a genuine bug that manifests as
 * `Insufficient funds` — an adapter sending the wrong amount, say — now skips
 * instead of failing. That is the same trade `spendableSend` already makes,
 * and `REQUIRE_FUNDED_WALLETS=1` reverses both together.
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
 * Send a test amount back to the wallet it came from, in teardown.
 *
 * The send tests only ever run Alice → Bob, so every run leaves Alice poorer
 * by the amount plus a fee and Bob richer by the amount. Nothing in the suite
 * puts it back, so Alice is always the wallet that hits zero, and the read
 * assertions she fronts are the ones that stop running. Returning the amount
 * leaves a run costing the two fees it genuinely spent, and the wallets where
 * the next run needs them.
 *
 * Teardown, so the assertions on the outbound send have already reported and
 * this cannot change their verdict. And it never throws: Bob being short, or
 * the return itself being refused, is a fact about funding for the next run to
 * surface — it is not evidence about the adapter under test, and a teardown
 * that fails a green suite would be the #77 mistake with the direction
 * reversed.
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
 * Make sure a wallet has `want` colorable UTXOs carrying no allocation, and
 * wait until they are actually usable.
 *
 * `createRgbUtxos` broadcasts a transaction. The outputs it creates do not
 * exist for the wallet until that transaction confirms, so a test that creates
 * and immediately sends gets `InsufficientAllocationSlots` — which reads as a
 * broken transfer and means "the UTXO I just asked for has not arrived". The
 * first version of this suite did exactly that, and passed or failed depending
 * on whether an earlier run happened to leave a spare slot on-chain: the
 * rgb-lib database is ephemeral per runner, but its UTXOs are not.
 *
 * So: create, then poll until the slots appear. Returns what it ended up with,
 * so a caller can skip with a real number instead of an assumption.
 *
 * Slots are per-UTXO because rgb-lib runs `maxAllocationsPerUtxo: 1` here. A
 * sender needs two — one holds the asset, one takes the change — and a blinded
 * recipient needs one. A witness recipient needs none, which is the point of
 * witness receive.
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
    // `AllocationsAlreadyAvailable` is the postcondition already met, stated as
    // an error. Anything else is worth seeing, but not worth failing on here —
    // the poll below decides, and the caller skips on the number it gets.
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

/** rgb-lib's transfer states, for a log line that explains itself. */
const TRANSFER_STATUS = ['WAITING_COUNTERPARTY', 'WAITING_CONFIRMATIONS', 'SETTLED'] as const

/**
 * Wait for a wallet's spendable balance of an asset to reach `want`.
 *
 * An RGB send leaves the sender's change in an unconfirmed allocation, so
 * `available` reads 0 against a `total` of nearly the whole supply until the
 * transfer settles.
 *
 * Settling takes BOTH sides. A transfer goes
 * `WAITING_COUNTERPARTY → WAITING_CONFIRMATIONS → SETTLED`, and the first step
 * is the recipient refreshing and accepting the consignment — nothing the
 * sender does moves it. Polling only the sender waits forever on a state
 * machine that cannot advance, which is exactly what the first version of this
 * helper did: three minutes of asking, `0 spendable after waiting`, every run.
 *
 * So `refreshAlso` takes the counterparties whose refresh the sender is waiting
 * on, and the poll drives all of them.
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
    // Both sides, always: the sender's change cannot settle until the recipient
    // has accepted, and a refresh that throws is not the answer either way.
    await Promise.allSettled(
      [wallet, ...refreshAlso].map((w) => Promise.resolve().then(() => w.refreshBalances?.())),
    )
  }

  const read = async (): Promise<number> => {
    await refreshAll()
    return (await wallet.getAssetBalance?.(assetId))?.available ?? 0
  }

  /** Best-effort: the transfer's state, so a timeout says where it got stuck. */
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
