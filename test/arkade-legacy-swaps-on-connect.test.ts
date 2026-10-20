import { describe, expect, it, vi } from 'vitest'

const cleanup = vi.fn().mockResolvedValue({ status: 'absent' })

vi.mock('../src/lib/legacy-arkade-swaps-cleanup', () => ({ cleanupLegacyArkadeSwapsDb: cleanup }))
vi.mock('../src/lib/arkade-client-manager', () => ({
  arkadeClientManager: {
    initialize: vi.fn().mockResolvedValue(undefined),
    getWallet: () => ({}),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isInitialized: () => true,
  },
}))

const { ArkadeAdapter } = await import('../src/adapters/ArkadeAdapter')

describe('ArkadeAdapter.connect', () => {
  it('runs the legacy Boltz store cleanup without waiting on it', async () => {
    cleanup.mockReturnValueOnce(new Promise(() => {}))
    await new ArkadeAdapter().connect({
      protocol: 'ARKADE',
      mnemonic: 'test test test test test test test test test test test junk',
      arkServerUrl: 'https://ark.example',
    } as never)
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
