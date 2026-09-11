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

/** Connect a local rgb-lib (RGB_L1, mutinynet/signet) adapter for the given wallet. */
export async function connectRgbL1(wallet: WalletFixture): Promise<RgbLibWdkAdapter> {
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
