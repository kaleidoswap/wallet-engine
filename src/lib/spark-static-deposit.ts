/**
 * Spark static (reusable) L1 deposit address: the receive flow Spark documents.
 *
 * Unlike a single-use address, it accepts any number of deposits, so a sender
 * reusing it never strands funds. Each deposit is claimed separately through
 * an SSP quote once it has the confirmations the SSP requires (3 by default);
 * until then the claim is rejected and the deposit counts as awaiting.
 *
 * `wallet` is the raw spark-sdk SparkWallet.
 */

/**
 * Upper bound on the SSP's claim fee (deposit minus credited amount). Spark
 * quotes ~100 sats; the cap only guards against a broken or hostile quote
 * silently eating a large deposit.
 */
export const STATIC_DEPOSIT_MAX_CLAIM_FEE_SATS = 5_000

const UTXO_PAGE_LIMIT = 100

export interface StaticDepositClaimResult {
  claimedTxids: string[]
  /** Confirmed UTXOs the SSP would not claim yet (too few confirmations). */
  awaitingTxids: string[]
  errors: string[]
}

interface StaticDepositWallet {
  getStaticDepositAddress(): Promise<string>
  getUtxosForDepositAddress(
    address: string,
    limit?: number,
    offset?: number,
    excludeClaimed?: boolean,
  ): Promise<Array<{ txid: string; vout: number }>>
  claimStaticDepositWithMaxFee(params: {
    transactionId: string
    maxFee: number
    outputIndex?: number
  }): Promise<unknown>
}

/** Whether the raw wallet exposes the static deposit API (spark-sdk >= 0.7). */
export function supportsStaticDeposits(wallet: unknown): wallet is StaticDepositWallet {
  const w = wallet as Partial<StaticDepositWallet> | null | undefined
  return (
    typeof w?.getStaticDepositAddress === 'function' &&
    typeof w.getUtxosForDepositAddress === 'function' &&
    typeof w.claimStaticDepositWithMaxFee === 'function'
  )
}

/** The SSP rejects a claim until the deposit has enough confirmations. */
export function isAwaitingConfirmationError(message: string): boolean {
  return /confirm/i.test(message)
}

/** Claim every unclaimed UTXO paid to this wallet's static deposit address. */
export async function claimStaticDeposits(
  wallet: StaticDepositWallet,
  address: string,
  maxFeeSats = STATIC_DEPOSIT_MAX_CLAIM_FEE_SATS,
): Promise<StaticDepositClaimResult> {
  const result: StaticDepositClaimResult = { claimedTxids: [], awaitingTxids: [], errors: [] }
  let utxos: Array<{ txid: string; vout: number }>
  try {
    utxos = (await wallet.getUtxosForDepositAddress(address, UTXO_PAGE_LIMIT, 0, true)) ?? []
  } catch (error: unknown) {
    result.errors.push(error instanceof Error ? error.message : 'utxo lookup failed')
    return result
  }
  for (const utxo of utxos) {
    try {
      await wallet.claimStaticDepositWithMaxFee({
        transactionId: utxo.txid,
        outputIndex: utxo.vout,
        maxFee: maxFeeSats,
      })
      result.claimedTxids.push(utxo.txid)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (isAwaitingConfirmationError(message)) result.awaitingTxids.push(utxo.txid)
      else result.errors.push(message)
    }
  }
  return result
}
