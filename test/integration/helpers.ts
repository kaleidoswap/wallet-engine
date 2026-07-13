/**
 * Integration-test helpers
 * ------------------------
 * Thin wrappers that build + connect each WDK adapter for a given wallet
 * (Alice/Bob) on its target test network, plus small assertions shared across
 * suites. All connect config comes from `config.ts`.
 */

import { expect } from 'vitest'
import type { IProtocolAdapter } from '../../src/adapters/IProtocolAdapter'
import { SparkWdkAdapter } from '../../src/adapters/wdk/SparkWdkAdapter'
import { LiquidWdkAdapter } from '../../src/adapters/wdk/LiquidWdkAdapter'
import { ArkadeWdkAdapter } from '../../src/adapters/wdk/ArkadeWdkAdapter'
import { RgbLibWdkAdapter } from '../../src/adapters/wdk/RgbLibWdkAdapter'
import { ARKADE, LIQUID, RGB_L1, SPARK, rgbDataDir, type WalletFixture } from './config'

/**
 * Retry a flaky async factory a few times with backoff. The Spark regtest
 * server intermittently drops its gRPC channel ("Channel has been shut down")
 * during wallet init; a fresh attempt almost always succeeds. Kept generic so
 * other public-endpoint suites can reuse it.
 */
async function withRetry<T>(
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
  const adapter = new LiquidWdkAdapter()
  await adapter.connect({
    protocol: 'LIQUID',
    network: LIQUID.network,
    mnemonic: wallet.mnemonic!,
    esploraUrl: LIQUID.esploraUrl,
  } as any)
  return adapter
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
 * Assert a wallet is funded: its total BTC-equivalent balance is a positive,
 * finite number. Surfaces the actual balance in the failure message so an
 * un-funded fixture is obvious.
 */
export function assertFunded(label: string, balance: { total: number }): void {
  expect(Number.isFinite(balance.total), `${label} balance should be a finite number`).toBe(true)
  expect(balance.total, `${label} should be funded (total > 0) on its test network`).toBeGreaterThan(0)
}

/**
 * Pick a small, safe send amount from a wallet's spendable balance for the
 * transfer tests. These run against shared, slowly-draining test wallets, so a
 * hardcoded amount eventually exceeds the balance and fails for the wrong
 * reason. Send a small fixed amount, but fail loudly (not skip) if the wallet
 * lacks even that plus a fee buffer.
 */
export function spendableSend(total: number, label: string, target = 100, feeBuffer = 200): number {
  expect(
    total,
    `${label}: needs > ${target + feeBuffer} sat spendable to exercise the send test (has ${total}) — top up the wallet`,
  ).toBeGreaterThan(target + feeBuffer)
  return target
}
