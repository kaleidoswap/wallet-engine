import { describe, it, expect, vi, afterEach } from 'vitest'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'

/**
 * AUDIT C-F8 — RgbAdapter.connect silently drops `config.jwt`, the field that
 * src/types/rgb.ts:28 documents as "JWT token for node authentication".
 *
 * connect() (src/adapters/RgbAdapter.ts:106-112) forwards ONLY `apiKey` to
 * kaleidoClientManager (which maps it to the node-scoped `nodeApiKey`). A host
 * following the RgbConfig docs and passing `jwt` gets zero node authentication,
 * with no error or warning. (The WDK sibling, RlnWdkAdapter.ts:154, accepts
 * both: `apiKey: cfg.jwt ?? cfg.apiKey`.)
 */
describe('AUDIT C-F8: RgbAdapter drops config.jwt', () => {
  afterEach(() => vi.restoreAllMocks())

  it('a jwt provided per the RgbConfig docs must reach the node client as the credential', async () => {
    let captured: any = null
    vi.spyOn(kaleidoClientManager, 'initialize').mockImplementation((c: any) => {
      captured = c
    })
    vi.spyOn(kaleidoClientManager, 'getClient').mockReturnValue({
      rln: { getNodeInfo: async () => ({ pubkey: 'pk' }) },
      maker: { listAssets: async () => [] },
    } as any)

    const adapter = new RgbAdapter()
    await adapter.connect({
      protocol: 'RGB_LN',
      network: 'regtest',
      nodeUrl: 'http://node:3001',
      makerUrl: '',
      jwt: 'TENANT_TOKEN',
    } as any)

    expect(captured).not.toBeNull()
    expect(captured.apiKey).toBe('TENANT_TOKEN')
  })
})
