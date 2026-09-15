import { describe, expect, it, vi, beforeEach } from 'vitest'

const initialize = vi.fn().mockResolvedValue(undefined)
const arkadeInitialize = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/lib/arkade-swaps-client-manager', () => ({
  arkadeSwapsClientManager: {
    initialize,
    dispose: vi.fn().mockResolvedValue(undefined),
    isInitialized: () => false,
  },
}))

vi.mock('../src/lib/arkade-client-manager', () => ({
  arkadeClientManager: {
    initialize: arkadeInitialize,
    getWallet: () => ({}),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isInitialized: () => true,
  },
}))

const { ArkadeAdapter } = await import('../src/adapters/ArkadeAdapter')

const config = {
  protocol: 'ARKADE' as const,
  mnemonic: 'test test test test test test test test test test test junk',
  arkServerUrl: 'https://ark.example',
}

beforeEach(() => initialize.mockClear())

// The Boltz client holds a WebSocket open (and retries it forever) for the life
// of the session, so a host that reaches Lightning another way should not pay
// for it just by connecting.
describe('ArkadeAdapter — Boltz swaps client', () => {
  it('stays off by default', async () => {
    await new ArkadeAdapter().connect(config)
    expect(initialize).not.toHaveBeenCalled()
  })

  it('starts when the host opts in', async () => {
    await new ArkadeAdapter().connect({ ...config, boltzSwapsEnabled: true })
    expect(initialize).toHaveBeenCalledOnce()
  })
})
