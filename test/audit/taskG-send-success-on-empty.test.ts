import { describe, expect, it } from 'vitest'
import { SparkWdkAdapter } from '../../src/adapters/wdk/SparkWdkAdapter'
import { ArkadeWdkAdapter } from '../../src/adapters/wdk/ArkadeWdkAdapter'

/**
 * Task G finding — WDK send paths report success with no evidence the send
 * happened. The contract (`PaymentResult`, src/types/base.ts:172-180) carries
 * `paymentHash`/`txid` + `status`; a caller treats `status: 'confirmed'` as
 * "funds moved". These adapters return exactly that when the SDK call resolves
 * WITHOUT any transaction id:
 *
 *  - src/adapters/wdk/SparkWdkAdapter.ts:464-471 — plain Spark transfer:
 *      paymentHash: transfer?.id ?? transfer?.transferId ?? ''
 *      status: transfer?.status ? mapTransferStatus(transfer.status) : 'confirmed'
 *    A result with no `status` field defaults to CONFIRMED.
 *  - src/adapters/wdk/ArkadeWdkAdapter.ts:343-352 — Ark transfer:
 *      const hash = r?.hash ?? ''  → returned with status 'confirmed'.
 *    Contrast: the SAME file's sendBtcOnchain guards this exact case and
 *    throws (lines 360-362): "Arkade offboard did not return a transaction ID".
 *  - src/adapters/wdk/LiquidWdkAdapter.ts:270 — paymentHash: r?.hash ?? ''
 *    (status 'pending' — softer, but still success-shaped with no id).
 */

describe('G-F1 [FIXED]: SparkWdkAdapter.sendPayment plain Spark transfer with a contentless SDK result', () => {
  it('must not report confirmed with an empty paymentHash', async () => {
    const a = new SparkWdkAdapter()
    Object.assign(a as any, {
      connected: true,
      account: { sendTransaction: async () => ({}) }, // SDK resolved, but no id/status
      sdk: {
        isValidSparkAddress: () => true,
        getNetworkFromSparkAddress: () => 'MAINNET',
        decodeSparkAddress: () => ({}), // no sparkInvoiceFields → plain transfer path
      },
    })
    // Correct contract behaviour: throw — nothing proves the transfer exists.
    await expect(
      a.sendPayment({ invoice: 'spark1qrecipient', amount: 1000 } as any),
    ).rejects.toThrow()
  })

  it('must not default a missing status field to confirmed', async () => {
    const a = new SparkWdkAdapter()
    Object.assign(a as any, {
      connected: true,
      account: { sendTransaction: async () => ({ id: 'tx-1' }) }, // id, but no status
      sdk: {
        isValidSparkAddress: () => true,
        getNetworkFromSparkAddress: () => 'MAINNET',
        decodeSparkAddress: () => ({}),
      },
    })
    const r = await a.sendPayment({ invoice: 'spark1qrecipient', amount: 1000 } as any)
    expect(r.status, 'unknown settlement state must not be reported as confirmed').not.toBe('confirmed')
  })
})

describe('G: ArkadeWdkAdapter.sendPayment Ark transfer with a contentless SDK result', () => {
  it('must not report confirmed with an empty txid (sendBtcOnchain in the same file throws here)', async () => {
    const a = new ArkadeWdkAdapter()
    Object.assign(a as any, {
      connected: true,
      account: { sendTransaction: async () => ({}) }, // no hash
    })
    await expect(
      a.sendPayment({ invoice: 'ark1qrecipient', amount: 1000 } as any),
    ).rejects.toThrow()
  })
})
