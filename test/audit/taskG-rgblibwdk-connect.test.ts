/*
 * OPEN FINDING — reproduction, not yet fixed.
 *
 * `describe.skip` so the branch stays green: these assert the behaviour the
 * contract requires. Remove the `.skip` when the finding is fixed and each
 * becomes its regression test. See REPORT.md section 2.2.
 */
import { describe, expect, it } from 'vitest'
import { RgbLibWdkAdapter } from '../../src/adapters/wdk/RgbLibWdkAdapter'
import { registerWdkModule } from '../../src/adapters/wdk/moduleLoader'

/**
 * Task G finding — RgbLibWdkAdapter.connect() reports success on failure.
 *
 * src/adapters/wdk/RgbLibWdkAdapter.ts:87-88:
 *     await this.account.registerWallet?.().catch(() => {})
 *     this.connected = true
 *
 * rgb-lib wallets must be registered with the indexer before ANY balance or
 * history call returns meaningful data (the file's own comment at line 86 and
 * getBtcBalance at 116 both depend on registerWallet). If registration fails
 * (indexer 404/500, first run behind a firewall), connect() RESOLVES and the
 * adapter reports connected — every later getBtcBalance()/listTransactions()
 * then operates on an unregistered wallet. The caller believes the wallet is
 * online; it is not.
 */

registerWdkModule('@utexo/wdk-wallet-rgb', () => ({
  WalletManagerRgb: class {
    constructor(_mnemonic: string, _opts: unknown) {}
    async getAccount() {
      return {
        registerWallet: async () => { throw new Error('indexer 404: wallet registration failed') },
      }
    }
  },
}))

describe.skip('G: RgbLibWdkAdapter.connect must fail when indexer registration fails', () => {
  it('connect() rejects and isConnected() stays false when registerWallet fails', async () => {
    const a = new RgbLibWdkAdapter()
    await expect(
      a.connect({ protocol: 'RGB_L1', mnemonic: 'mnemonic', dataDir: '/tmp/x' } as any),
    ).rejects.toThrow(/registration|indexer/i)
    expect(a.isConnected()).toBe(false)
  })
})
