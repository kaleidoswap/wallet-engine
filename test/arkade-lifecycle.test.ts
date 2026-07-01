import { describe, it, expect } from 'vitest'
import {
  sanitizeDelegatorUrl,
  sanitizeDelegationEnabled,
  sanitizeVtxoThresholdSeconds,
  resolveArkadeLifecycleSettings,
  delegateSpendableVtxos,
  getArkadeDelegateInfo,
  runArkadeVtxoLifecycle,
  ARKADE_DELEGATOR_URLS,
  DEFAULT_VTXO_THRESHOLD_SECONDS,
} from '../src/lib/arkade-vtxo-lifecycle'

// --- settings sanitizers -----------------------------------------------------

describe('sanitizeDelegatorUrl', () => {
  it('falls back to the network default for missing / non-https / bad input', () => {
    expect(sanitizeDelegatorUrl(undefined, 'mainnet')).toBe(ARKADE_DELEGATOR_URLS.mainnet)
    expect(sanitizeDelegatorUrl('', 'signet')).toBe(ARKADE_DELEGATOR_URLS.signet)
    expect(sanitizeDelegatorUrl('http://insecure.example', 'mainnet')).toBe(
      ARKADE_DELEGATOR_URLS.mainnet,
    )
    expect(sanitizeDelegatorUrl('not a url', 'mainnet')).toBe(ARKADE_DELEGATOR_URLS.mainnet)
  })

  it('accepts a valid https url', () => {
    expect(sanitizeDelegatorUrl('https://custom.delegator.example', 'mainnet')).toBe(
      'https://custom.delegator.example',
    )
  })
})

describe('sanitizeDelegationEnabled', () => {
  it('defaults to true when undefined and coerces common shapes', () => {
    expect(sanitizeDelegationEnabled(undefined)).toBe(true)
    expect(sanitizeDelegationEnabled(true)).toBe(true)
    expect(sanitizeDelegationEnabled(false)).toBe(false)
    expect(sanitizeDelegationEnabled('yes')).toBe(true)
    expect(sanitizeDelegationEnabled('0')).toBe(false)
    expect(sanitizeDelegationEnabled(1)).toBe(true)
    expect(sanitizeDelegationEnabled(0)).toBe(false)
  })
})

describe('sanitizeVtxoThresholdSeconds', () => {
  it('returns positive integers, else the 3-day default', () => {
    expect(sanitizeVtxoThresholdSeconds(3600)).toBe(3600)
    expect(sanitizeVtxoThresholdSeconds('7200')).toBe(7200)
    expect(sanitizeVtxoThresholdSeconds(-1)).toBe(DEFAULT_VTXO_THRESHOLD_SECONDS)
    expect(sanitizeVtxoThresholdSeconds('nope')).toBe(DEFAULT_VTXO_THRESHOLD_SECONDS)
    expect(sanitizeVtxoThresholdSeconds(120.9)).toBe(120)
  })
})

describe('resolveArkadeLifecycleSettings', () => {
  it('sanitizes a full raw object', () => {
    const s = resolveArkadeLifecycleSettings({
      delegatorUrl: 'https://d.example',
      delegationEnabled: 'true',
      vtxoThresholdSeconds: '900',
      network: 'signet',
    })
    expect(s).toEqual({
      delegatorUrl: 'https://d.example',
      delegationEnabled: true,
      vtxoThresholdSeconds: 900,
    })
  })

  it('applies network default url + enabled default when fields are absent', () => {
    const s = resolveArkadeLifecycleSettings({ network: 'signet' })
    expect(s.delegatorUrl).toBe(ARKADE_DELEGATOR_URLS.signet)
    expect(s.delegationEnabled).toBe(true)
    expect(s.vtxoThresholdSeconds).toBe(DEFAULT_VTXO_THRESHOLD_SECONDS)
  })
})

// --- delegator helpers -------------------------------------------------------

describe('delegateSpendableVtxos', () => {
  it('returns {0,0} when no delegator manager is configured', async () => {
    const wallet = { getDelegatorManager: async () => null } as any
    expect(await delegateSpendableVtxos(wallet)).toEqual({ delegated: 0, failed: 0 })
  })

  it('returns {0,0} when there is nothing spendable', async () => {
    const wallet = {
      getDelegatorManager: async () => ({ delegate: async () => ({ delegated: [], failed: [] }) }),
      getVtxos: async () => [{ virtualStatus: { state: 'swept' } }],
      getAddress: async () => 'ark1own',
    } as any
    expect(await delegateSpendableVtxos(wallet)).toEqual({ delegated: 0, failed: 0 })
  })

  it('delegates settled/preconfirmed vtxos to own address', async () => {
    const seen: any = {}
    const wallet = {
      getDelegatorManager: async () => ({
        delegate: async (vtxos: any[], addr: string) => {
          seen.count = vtxos.length
          seen.addr = addr
          return { delegated: [1, 2], failed: [3] }
        },
      }),
      getVtxos: async () => [
        { virtualStatus: { state: 'settled' } },
        { virtualStatus: { state: 'preconfirmed' } },
        { virtualStatus: { state: 'swept' } },
      ],
      getAddress: async () => 'ark1own',
    } as any
    const res = await delegateSpendableVtxos(wallet)
    expect(seen.count).toBe(2)
    expect(seen.addr).toBe('ark1own')
    expect(res).toEqual({ delegated: 2, failed: 1 })
  })
})

describe('getArkadeDelegateInfo', () => {
  it('reports not configured without a delegator manager', async () => {
    const wallet = { getDelegatorManager: async () => null } as any
    expect(await getArkadeDelegateInfo(wallet)).toEqual({ configured: false })
  })

  it('merges delegate info when configured', async () => {
    const wallet = {
      getDelegatorManager: async () => ({
        getDelegateInfo: async () => ({ pubkey: 'pk', fee: 10 }),
      }),
    } as any
    expect(await getArkadeDelegateInfo(wallet)).toEqual({ configured: true, pubkey: 'pk', fee: 10 })
  })
})

// --- lifecycle runner --------------------------------------------------------

function baseVtxoManager(overrides: Record<string, unknown> = {}) {
  return {
    getExpiringVtxos: async () => [],
    renewVtxos: async () => 'renew-txid',
    getRecoverableBalance: async () => ({
      recoverable: 0n,
      subdust: 0n,
      includesSubdust: false,
      vtxoCount: 0,
    }),
    getExpiredBoardingUtxos: async () => [],
    ...overrides,
  } as any
}

describe('runArkadeVtxoLifecycle', () => {
  it('renews expiring vtxos and fires the callback', async () => {
    const renewed: any[] = []
    const vtxoManager = baseVtxoManager({
      getExpiringVtxos: async () => [{}, {}],
      renewVtxos: async (cb: (e: { type: string }) => void) => {
        cb({ type: 'signing' })
        return 'commit-txid'
      },
    })
    const wallet = {} as any
    const result = await runArkadeVtxoLifecycle({
      vtxoManager,
      wallet,
      callbacks: { onVtxosRenewed: (i) => renewed.push(i) },
    })
    expect(result.renewed).toEqual({ count: 2, txid: 'commit-txid' })
    expect(renewed).toEqual([{ count: 2, txid: 'commit-txid' }])
  })

  it('surfaces recoverable + boarding-expiry and skips delegation when disabled', async () => {
    const vtxoManager = baseVtxoManager({
      getRecoverableBalance: async () => ({
        recoverable: 1000n,
        subdust: 0n,
        includesSubdust: false,
        vtxoCount: 3,
      }),
      getExpiredBoardingUtxos: async () => [{ txid: 'a', vout: 0, value: 500 }],
    })
    const result = await runArkadeVtxoLifecycle({ vtxoManager, wallet: {} as any })
    expect(result.recoverable?.vtxoCount).toBe(3)
    expect(result.expiredBoardingCount).toBe(1)
    expect(result.delegated).toBeNull()
  })

  it('delegates when enabled + configured', async () => {
    const wallet = {
      getDelegatorManager: async () => ({
        delegate: async () => ({ delegated: [1], failed: [] }),
      }),
      getVtxos: async () => [{ virtualStatus: { state: 'settled' } }],
      getAddress: async () => 'ark1own',
    } as any
    const result = await runArkadeVtxoLifecycle({
      vtxoManager: baseVtxoManager(),
      wallet,
      config: { delegationEnabled: true, delegatorUrl: 'https://d.example' },
    })
    expect(result.delegated).toEqual({ delegated: 1, failed: 0 })
  })

  it('isolates a stage failure into errors without aborting later stages', async () => {
    const errs: string[] = []
    const vtxoManager = baseVtxoManager({
      getExpiringVtxos: async () => {
        throw new Error('renew boom')
      },
      getExpiredBoardingUtxos: async () => [{}, {}],
    })
    const result = await runArkadeVtxoLifecycle({
      vtxoManager,
      wallet: {} as any,
      callbacks: { onError: (stage) => errs.push(stage) },
    })
    expect(result.renewed).toBeNull()
    expect(result.errors.some((e) => e.startsWith('renew:'))).toBe(true)
    expect(errs).toContain('renew')
    // later stages still ran
    expect(result.expiredBoardingCount).toBe(2)
  })
})
