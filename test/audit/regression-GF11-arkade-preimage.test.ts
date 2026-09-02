/**
 * AUDIT G-F11 — Arkade Lightning `PaymentResult.paymentHash` carried the PREIMAGE.
 *
 * `paymentHash: result.preimage ?? result.txid ?? ''` meant that whenever Boltz
 * resolved with a preimage but no on-chain txid yet:
 *   a) a SECRET (the payment preimage — proof of payment) landed in the field
 *      hosts persist, log and display as the payment's public identifier; and
 *   b) `getPaymentStatus(paymentHash)`, which searches history by that value,
 *      could never match — so the payment stayed pending forever.
 * With neither field present it returned success with `paymentHash: ''`.
 *
 * Four sibling adapters (RgbAdapter ×2, SparkAdapter, SparkWdkAdapter,
 * RlnWdkAdapter) keep the preimage in `PaymentResult.preimage`, which exists for
 * exactly this (types/base.ts:175).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const swapsState = { result: null as unknown }

vi.mock('@arkade-os/boltz-swap', () => ({
  ArkadeSwaps: { create: async () => ({ dispose: async () => {} }) },
  IndexedDbSwapRepository: class {
    constructor(_n: string) {}
  },
}))

import { ArkadeAdapter } from '../../src/adapters/ArkadeAdapter'
import { ArkadeWdkAdapter } from '../../src/adapters/wdk/ArkadeWdkAdapter'
import { arkadeClientManager } from '../../src/lib/arkade-client-manager'
import { arkadeSwapsClientManager } from '../../src/lib/arkade-swaps-client-manager'

const PREIMAGE = 'ab'.repeat(32)
const INVOICE = 'lnbc10u1pexample'

function nativeAdapter() {
  const adapter = new ArkadeAdapter()
  vi.spyOn(arkadeClientManager, 'isInitialized').mockReturnValue(true)
  vi.spyOn(arkadeSwapsClientManager, 'isInitialized').mockReturnValue(true)
  vi.spyOn(arkadeSwapsClientManager, 'getClient').mockReturnValue({
    sendLightningPayment: async () => swapsState.result,
  } as never)
  Object.assign(adapter as never, { config: { protocol: 'ARKADE', network: 'signet' } })
  return adapter
}

function wdkAdapter() {
  const adapter = new ArkadeWdkAdapter()
  Object.assign(adapter as never, {
    connected: true,
    account: {
      arkadeSwaps: { sendLightningPayment: async () => swapsState.result },
    },
  })
  return adapter
}

afterEach(() => {
  vi.restoreAllMocks()
  swapsState.result = null
})

describe('G-F11: the preimage must not be reported as the payment hash', () => {
  it('native ArkadeAdapter: a preimage-only result puts the secret in `preimage`, not `paymentHash`', async () => {
    swapsState.result = { preimage: PREIMAGE, amount: 1000 }
    const r = await nativeAdapter().sendPayment({ invoice: INVOICE })
    expect(r.preimage).toBe(PREIMAGE)
    expect(r.paymentHash).not.toBe(PREIMAGE)
    expect(r.paymentHash).toBe('')
  })

  it('native ArkadeAdapter: a txid result is the payment hash', async () => {
    swapsState.result = { txid: 'boltz-txid', preimage: PREIMAGE, amount: 1000 }
    const r = await nativeAdapter().sendPayment({ invoice: INVOICE })
    expect(r.paymentHash).toBe('boltz-txid')
    expect(r.preimage).toBe(PREIMAGE)
  })

  it('native ArkadeAdapter: neither txid nor preimage is a send error, not a success', async () => {
    swapsState.result = { amount: 1000 }
    await expect(nativeAdapter().sendPayment({ invoice: INVOICE })).rejects.toThrow(
      /no transaction id and no preimage/i,
    )
  })

  it('ArkadeWdkAdapter: same three cases', async () => {
    swapsState.result = { preimage: PREIMAGE, amount: 1000 }
    let r = await wdkAdapter().sendPayment({ invoice: INVOICE })
    expect(r.preimage).toBe(PREIMAGE)
    expect(r.paymentHash).not.toBe(PREIMAGE)

    swapsState.result = { txid: 'boltz-txid', preimage: PREIMAGE, amount: 1000 }
    r = await wdkAdapter().sendPayment({ invoice: INVOICE })
    expect(r.paymentHash).toBe('boltz-txid')

    swapsState.result = { amount: 1000 }
    await expect(wdkAdapter().sendPayment({ invoice: INVOICE })).rejects.toThrow(
      /no transaction id and no preimage/i,
    )
  })
})
