/*
 * OPEN FINDING — reproduction, not yet fixed.
 *
 * `describe.skip` so the branch stays green: these assert the behaviour the
 * code SHOULD have. Remove the `.skip` when the finding is fixed and they
 * become its regression test. See REPORT.md for the finding this belongs to.
 */
import { describe, it, expect } from 'vitest'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { RlnWdkAdapter } from '../../src/adapters/wdk/RlnWdkAdapter'
import { RgbLibWasmAdapter } from '../../src/adapters/wdk/RgbLibWasmAdapter'
import { registerWdkModule } from '../../src/adapters/wdk/moduleLoader'
import { MAINNET_FEE_FLOOR } from '../../src/lib/rgb-fee-policy'

/**
 * AUDIT C-F6 — the mainnet fee floor (rgb-fee-policy, [GL #26]) is only wired
 * into the legacy RgbAdapter, and even there an absent `network` defeats it.
 *
 *  a) RgbAdapter.connect never defaults `network` (BaseProtocolConfig.network is
 *     optional); resolveFeeRate passes `this.config?.network ?? null`
 *     (src/adapters/RgbAdapter.ts:809) and the policy maps null -> 1 sat/vB —
 *     while the WDK adapters default an absent network to 'mainnet'
 *     (RlnWdkAdapter.ts:143). A host that omits `network` against a mainnet
 *     node gets a 1 sat/vB mainnet tx (stuck funds).
 *  b) RgbLibWasmAdapter hardcodes `?? 1` for every on-chain op
 *     (src/adapters/wdk/RgbLibWasmAdapter.ts:482,563,582) — no floor at all.
 *  c) RlnWdkAdapter never calls the policy: sendAsset forwards an undefined
 *     feeRate (SDK default 3 sat/vB), createRgbUtxos trusts a cold node's
 *     estimate with `?? 1` fallback (RlnWdkAdapter.ts:494,503).
 */

describe('AUDIT C-F6: mainnet fee floor bypass', () => {
  it('a) RgbAdapter with no `network` in config must fail CLOSED to the mainnet floor, not 1 sat/vB', async () => {
    const adapter = new RgbAdapter()
    // Host omitted `network` — optional per BaseProtocolConfig.
    Object.assign(adapter as any, {
      connected: true,
      config: { protocol: 'RGB_LN', nodeUrl: 'http://node:3001', makerUrl: '' },
    })
    const rate = await (adapter as any).resolveFeeRate(undefined, 'normal')
    expect(rate).toBeGreaterThanOrEqual(MAINNET_FEE_FLOOR.normal)
  })

  it('b) RgbLibWasmAdapter.sendAsset on mainnet without feeRate must not build a 1 sat/vB tx', async () => {
    let seenFeeRate: bigint | null = null
    const fakeWallet: any = {
      goOnline: async () => 'online',
      sync: async () => {},
      refresh: async () => {},
      flush: async () => {},
      sendBegin: async (_online: any, _map: any, _donation: boolean, feeRate: bigint) => {
        seenFeeRate = feeRate
        return 'unsigned-psbt'
      },
      signPsbt: async () => 'signed-psbt',
      sendEnd: async () => ({ txid: 'tx' }),
    }
    registerWdkModule('@utexo/rgb-lib-wasm', () => ({
      init: () => {},
      restoreKeys: () => ({
        mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        masterFingerprint: 'aa',
        accountXpubVanilla: 'xpub1',
        accountXpubColored: 'xpub2',
      }),
      WasmWallet: { create: async () => fakeWallet },
    }))

    const adapter = new RgbLibWasmAdapter()
    await adapter.connect({
      protocol: 'RGB_L1',
      network: 'mainnet',
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      indexerUrl: 'http://indexer',
    } as any)
    await adapter.sendAsset({ token: 'rgb:asset', recipient: 'utxob:rcpt', amount: 5 })
    expect(Number(seenFeeRate)).toBeGreaterThanOrEqual(MAINNET_FEE_FLOOR.normal)
  })

  it('c) RlnWdkAdapter.createRgbUtxos on mainnet must floor a cold-node 1 sat/vB estimate', async () => {
    let body: any = null
    const adapter = new RlnWdkAdapter()
    Object.assign(adapter as any, {
      connected: true,
      network: 'mainnet',
      account: {
        estimateFee: async () => ({ fee_rate: 1 }), // cold-started node
        createUtxos: async (b: any) => {
          body = b
        },
      },
    })
    await adapter.createRgbUtxos()
    expect(body.fee_rate).toBeGreaterThanOrEqual(MAINNET_FEE_FLOOR.normal)
  })
})
