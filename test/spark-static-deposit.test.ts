import { afterEach, describe, expect, it, vi } from 'vitest'

const sparkState = vi.hoisted(() => ({ wallet: null as unknown }))
vi.mock('../src/lib/spark-client-manager', () => ({
  sparkClientManager: {
    isInitialized: () => sparkState.wallet !== null,
    getWallet: () => sparkState.wallet,
    getConfig: () => ({ protocol: 'SPARK', network: 'regtest', mnemonic: '' }),
    initialize: async () => {},
    disconnect: async () => {},
    adoptExternalWallet: () => {},
    releaseExternalWallet: () => {},
  },
}))

import { SparkAdapter } from '../src/adapters/SparkAdapter'
import { SparkWdkAdapter } from '../src/adapters/wdk/SparkWdkAdapter'
import { claimStaticDeposits, STATIC_DEPOSIT_MAX_CLAIM_FEE_SATS } from '../src/lib/spark-static-deposit'

const STATIC = 'bcrt1pstatic'
const LEGACY = 'bcrt1plegacy'

/** Raw SDK wallet with one static address and per-address unclaimed UTXOs. */
function rawWallet(
  utxos: Record<string, Array<{ txid: string; vout: number }>>,
  claimStatic: (p: { transactionId: string }) => Promise<unknown> = async () => ({}),
) {
  return {
    getStaticDepositAddress: vi.fn(async () => STATIC),
    getSingleUseDepositAddress: vi.fn(async () => 'bcrt1pfresh'),
    getUtxosForDepositAddress: vi.fn(async (addr: string) => utxos[addr] ?? []),
    claimStaticDepositWithMaxFee: vi.fn(claimStatic),
    claimDeposit: vi.fn(async () => []),
    getUnusedDepositAddresses: vi.fn(async () => Object.keys(utxos).filter((a) => a !== STATIC)),
  }
}

function nativeAdapter(wallet: unknown) {
  sparkState.wallet = wallet
  const adapter = new SparkAdapter()
  Object.assign(adapter as any, { connected: true })
  return adapter
}

function wdkAdapter(wallet: any) {
  const adapter = new SparkWdkAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account: {
      _wallet: wallet,
      getStaticDepositAddress: wallet.getStaticDepositAddress,
      getSingleUseDepositAddress: wallet.getSingleUseDepositAddress,
    },
  })
  return adapter
}

afterEach(() => {
  sparkState.wallet = null
})

describe('claimStaticDeposits', () => {
  it('claims each UTXO with its output index under the fee cap', async () => {
    const wallet = rawWallet({ [STATIC]: [{ txid: 'a', vout: 1 }, { txid: 'b', vout: 0 }] })
    const result = await claimStaticDeposits(wallet, STATIC)
    expect(result).toEqual({ claimedTxids: ['a', 'b'], awaitingTxids: [], errors: [] })
    expect(wallet.claimStaticDepositWithMaxFee).toHaveBeenCalledWith({
      transactionId: 'a',
      outputIndex: 1,
      maxFee: STATIC_DEPOSIT_MAX_CLAIM_FEE_SATS,
    })
  })

  it('keeps an under-confirmed deposit awaiting and reports other failures', async () => {
    const wallet = rawWallet(
      { [STATIC]: [{ txid: 'young', vout: 0 }, { txid: 'dust', vout: 0 }] },
      async ({ transactionId }) => {
        throw new Error(
          transactionId === 'young'
            ? 'deposit transaction does not have enough confirmations'
            : 'utxo amount minus fees is less than the dust amount',
        )
      },
    )
    const result = await claimStaticDeposits(wallet, STATIC)
    expect(result.claimedTxids).toEqual([])
    expect(result.awaitingTxids).toEqual(['young'])
    expect(result.errors).toEqual(['utxo amount minus fees is less than the dust amount'])
  })
})

describe('isAwaitingConfirmationError', () => {
  it('treats unseen and under-confirmed deposits as awaiting', async () => {
    const { isAwaitingConfirmationError } = await import('../src/lib/spark-static-deposit')
    // Verbatim from Spark regtest, before the deposit tx was indexed.
    expect(isAwaitingConfirmationError('Failed to execute GraphQL query: Request StaticDepositQuote failed. [{"message":"Transaction not found."}]')).toBe(true)
    expect(isAwaitingConfirmationError('Invalid transaction hex [field: txHex, value: {"error":"No such mempool or blockchain transaction"}]')).toBe(true)
    expect(isAwaitingConfirmationError('deposit does not have enough confirmations')).toBe(true)
    expect(isAwaitingConfirmationError('Fee larger than max fee')).toBe(false)
    expect(isAwaitingConfirmationError('utxo amount minus fees is less than the dust amount')).toBe(false)
  })
})

describe.each([
  ['SparkAdapter', nativeAdapter],
  ['SparkWdkAdapter', wdkAdapter],
] as const)('%s static deposits', (_name, make) => {
  it('receives BTC on the static deposit address', async () => {
    const wallet = rawWallet({})
    const address = await make(wallet).getReceiveAddress('BTC')
    expect(address).toEqual({ address: STATIC, format: 'BTC_ADDRESS', asset: 'BTC' })
    expect(wallet.getSingleUseDepositAddress).not.toHaveBeenCalled()
  })

  it('claims the static address through the SSP quote, not claimDeposit', async () => {
    const wallet = rawWallet({ [STATIC]: [{ txid: 'a', vout: 0 }] })
    const result = await make(wallet).claimSparkL1Deposit({ address: STATIC })
    expect(result).toEqual({ status: 'claimed', txids: ['a'] })
    expect(wallet.claimDeposit).not.toHaveBeenCalled()
  })

  it('stays awaiting while the static deposit lacks confirmations', async () => {
    const wallet = rawWallet({ [STATIC]: [{ txid: 'a', vout: 0 }] }, async () => {
      throw new Error('not enough confirmations')
    })
    expect(await make(wallet).claimSparkL1Deposit({ address: STATIC })).toEqual({ status: 'awaiting' })
  })

  it('still claims an earlier single-use address with claimDeposit', async () => {
    const wallet = rawWallet({ [LEGACY]: [{ txid: 'old', vout: 0 }] })
    const result = await make(wallet).claimSparkL1Deposit({ address: LEGACY })
    expect(result).toEqual({ status: 'claimed', txids: ['old'] })
    expect(wallet.claimDeposit).toHaveBeenCalledWith('old')
    expect(wallet.claimStaticDepositWithMaxFee).not.toHaveBeenCalled()
  })

  it('sweeps the static address and the legacy single-use set', async () => {
    const wallet = rawWallet({
      [STATIC]: [{ txid: 'static-tx', vout: 0 }],
      [LEGACY]: [{ txid: 'legacy-tx', vout: 0 }],
    })
    const result = await make(wallet).sweepSparkL1Deposits()
    expect(result.claimedTxids).toEqual(['static-tx', 'legacy-tx'])
    expect(result).toMatchObject({ addressesChecked: 1, addressesTotal: 1, errors: [] })
  })

  it('reports static claims even with no legacy addresses left', async () => {
    const wallet = rawWallet({ [STATIC]: [{ txid: 'static-tx', vout: 0 }] })
    const result = await make(wallet).sweepSparkL1Deposits()
    expect(result).toMatchObject({ addressesChecked: 0, claimedTxids: ['static-tx'], errors: [] })
  })
})
