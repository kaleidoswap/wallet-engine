/**
 * Prints the funding addresses for Alice & Bob on every network, so you know where
 * to send test coins before running the funded assertions — and what each wallet
 * already holds, which is the half that says whether a top-up is needed at all.
 *
 *   npm run test:integration -- print-funding-addresses --silent=false
 *
 * `--silent=false` matters: vitest hides console output from passing tests, and
 * every test here passes by design.
 *
 * Each protocol logs independently and never fails the run.
 */

import { describe, it } from 'vitest'
import {
  ALICE,
  ARKADE,
  BOB,
  HAVE_WALLETS,
  LIQUID,
  RGB_L1,
  SPARK,
  type WalletFixture,
} from './config'
import {
  connectArkade,
  connectLiquid,
  connectRgbL1,
  connectSpark,
  safeDisconnect,
} from './helpers'

type Row = { wallet: string; fund: string; balance: string; address: string }

/** A wallet's balance as one cell: what it holds, and what it can actually spend. */
function held(balance: { confirmed: number; total: number }): string {
  return `${balance.total} sat (${balance.confirmed} spendable)`
}

async function collect(
  label: string,
  enabled: boolean,
  fn: (w: WalletFixture) => Promise<Row[]>,
): Promise<void> {
  if (!enabled) {
    console.log(`\n[${label}] skipped (disabled / no mnemonics)`)
    return
  }
  const rows: Row[] = []
  for (const w of [ALICE, BOB]) {
    try {
      rows.push(...(await fn(w)))
    } catch (e: any) {
      console.log(`\n[${label}] ${w.name}: FAILED — ${e?.message ?? e}`)
    }
  }
  if (rows.length) {
    console.log(`\n[${label}] fund these addresses:`)
    console.table(rows)
  }
}

describe.skipIf(!HAVE_WALLETS)('funding addresses (Alice & Bob)', () => {
  it('prints Spark regtest addresses', async () => {
    await collect('SPARK · regtest', SPARK.enabled, async (w) => {
      const a = await connectSpark(w)
      try {
        const spark = await a.getReceiveAddress('SPARK')
        const btc = await a.getReceiveAddress('btc') // single-use L1 deposit
        const balance = held(await a.getBtcBalance())
        return [
          { wallet: w.name, fund: 'Spark (native)', balance, address: spark.address },
          { wallet: w.name, fund: 'Spark L1 deposit (BTC)', balance: '↑ same wallet', address: btc.address },
        ]
      } finally {
        await safeDisconnect(a)
      }
    })
  }, 120_000)

  it('prints Liquid testnet addresses', async () => {
    await collect('LIQUID · testnet', LIQUID.enabled, async (w) => {
      const a = await connectLiquid(w)
      try {
        const addr = await a.getReceiveAddress()
        const balance = held(await a.getBtcBalance())
        return [{ wallet: w.name, fund: 'Liquid L-BTC (testnet)', balance, address: addr.address }]
      } finally {
        await safeDisconnect(a)
      }
    })
  }, 180_000)

  it('prints Arkade mutinynet addresses', async () => {
    await collect('ARKADE · mutinynet', ARKADE.enabled, async (w) => {
      const a = await connectArkade(w)
      try {
        const ark = await a.getReceiveAddress()
        const boarding = await a.getBoardingAddress()
        // `spendable` here is settled + preconfirmed VTXOs. Boarding UTXOs that
        // were never onboarded sit outside it — a 0 that a faucet will not fix.
        const balance = held(await a.getBtcBalance())
        return [
          { wallet: w.name, fund: 'Arkade (Ark address)', balance, address: ark.address },
          { wallet: w.name, fund: 'Arkade boarding (on-chain BTC)', balance: '↑ same wallet', address: boarding.address },
        ]
      } finally {
        await safeDisconnect(a)
      }
    })
  }, 180_000)

  it('prints RGB-L1 mutinynet addresses', async () => {
    await collect('RGB_L1 · mutinynet', RGB_L1.enabled, async (w) => {
      const a = await connectRgbL1(w)
      try {
        const addr = await a.getReceiveAddress() // BTC on-chain (vanilla)
        const balance = held(await a.getBtcBalance())
        return [{ wallet: w.name, fund: 'RGB-L1 on-chain BTC', balance, address: addr.address }]
      } finally {
        await safeDisconnect(a)
      }
    })
  }, 240_000)
})
