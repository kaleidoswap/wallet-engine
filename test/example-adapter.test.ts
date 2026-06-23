import { describe, it, expect } from 'vitest'
import { ProtocolManager } from '../src/manager/ProtocolManager'
import { MemoAdapter } from '../examples/minimal-adapter/MemoAdapter'

/**
 * Exercises the documented minimal-adapter example end-to-end through the
 * ProtocolManager. Doubles as a guard so the example cannot rot out of sync with
 * the contract.
 */
describe('examples/minimal-adapter (MemoAdapter)', () => {
  it('registers, connects, and lists assets through the manager', async () => {
    const manager = new ProtocolManager({ defaultProtocol: 'BTC' })
    manager.registerAdapter(new MemoAdapter())
    await manager.connect('BTC', { protocol: 'BTC' })

    expect(manager.getActiveProtocol()).toBe('BTC')
    const assets = await manager.listAllAssets()
    expect(assets).toHaveLength(1)
    expect(assets[0]).toMatchObject({ id: 'BTC', ticker: 'BTC', protocol: 'BTC' })
  })

  it('satisfies the contract surface the manager relies on', async () => {
    const adapter = new MemoAdapter()
    await adapter.connect({ protocol: 'BTC' })
    expect(adapter.isConnected()).toBe(true)
    expect((await adapter.getReceiveAddress()).format).toBe('BTC_ADDRESS')
    expect(adapter.supportsSwaps()).toBe(false)
  })
})
