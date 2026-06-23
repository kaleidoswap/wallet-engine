import { describe, it, expect } from 'vitest'
import { RlnWdkAdapter } from '../src/adapters/wdk/RlnWdkAdapter'
import { ArkadeWdkAdapter } from '../src/adapters/wdk/ArkadeWdkAdapter'

/**
 * executeProtocolOperation must dispatch ONLY allowlisted operation names and
 * never use the caller-supplied string to index the account object directly
 * (which would reach `constructor`, prototype methods, etc.). See S2.
 */
function connectedRln() {
  const calls: any[] = []
  const adapter = new RlnWdkAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account: {
      listSwaps: async (p: any) => {
        calls.push(['listSwaps', p])
        return { swaps: [] }
      },
      // a sensitive method that is NOT on the allowlist
      changePassword: async () => 'changed',
    },
  })
  return { adapter, calls }
}

describe('RlnWdkAdapter.executeProtocolOperation allowlist', () => {
  it('dispatches an allowlisted operation', async () => {
    const { adapter, calls } = connectedRln()
    await adapter.executeProtocolOperation('listSwaps', { foo: 1 })
    expect(calls[0]).toEqual(['listSwaps', { foo: 1 }])
  })

  it('rejects a non-allowlisted method even if it exists on the account', async () => {
    // `changePassword` IS on the RLN allowlist by design; use a clearly off-list name.
    const { adapter } = connectedRln()
    await expect(adapter.executeProtocolOperation('listAssetsRaw', {})).rejects.toThrow(/not allowed/i)
  })

  it('rejects prototype/meta members', async () => {
    const { adapter } = connectedRln()
    for (const op of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      await expect(
        adapter.executeProtocolOperation(op, {}),
        `"${op}" must be rejected`,
      ).rejects.toThrow(/not allowed/i)
    }
  })
})

describe('ArkadeWdkAdapter.executeProtocolOperation allowlist', () => {
  function connectedArkade() {
    const adapter = new ArkadeWdkAdapter()
    Object.assign(adapter as any, {
      connected: true,
      account: { getLightningLimits: async () => ({ min: 1, max: 2 }) },
    })
    return adapter
  }

  it('dispatches an allowlisted Arkade op', async () => {
    const adapter = connectedArkade()
    await expect(adapter.executeProtocolOperation('getLightningLimits', {})).resolves.toMatchObject({ min: 1 })
  })

  it('rejects meta members', async () => {
    const adapter = connectedArkade()
    await expect(adapter.executeProtocolOperation('constructor', {})).rejects.toThrow(/not allowed/i)
  })
})
