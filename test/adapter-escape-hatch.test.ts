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
    const { adapter } = connectedRln()
    await expect(adapter.executeProtocolOperation('listAssetsRaw', {})).rejects.toThrow(/not allowed/i)
  })

  it('rejects wallet-lifecycle ops (changePassword/restore) even though the account exposes them', async () => {
    const { adapter } = connectedRln()
    await expect(adapter.executeProtocolOperation('changePassword', {})).rejects.toThrow(/not allowed/i)
    await expect(adapter.executeProtocolOperation('restore', {})).rejects.toThrow(/not allowed/i)
  })

  it('refuses node-side signMessage over the LNURL-auth canonical phrase', async () => {
    const adapter = new RlnWdkAdapter()
    const signed: string[] = []
    Object.assign(adapter as any, {
      connected: true,
      account: {
        signMessage: async (p: any) => {
          signed.push(typeof p === 'string' ? p : p.message)
          return { signature: 'sig' }
        },
      },
    })
    const phrase =
      'DO NOT EVER SIGN THIS TEXT WITH YOUR PRIVATE KEYS! IT IS ONLY USED FOR DERIVATION OF LNURL-AUTH HASHING-KEY, DISCLOSING ITS SIGNATURE WILL COMPROMISE YOUR LNURL-AUTH IDENTITY AND MAY LEAD TO LOSS OF FUNDS!'
    await expect(adapter.executeProtocolOperation('signMessage', { message: phrase })).rejects.toThrow(
      /refusing to sign/i,
    )
    await expect(adapter.executeProtocolOperation('signMessage', phrase)).rejects.toThrow(/refusing to sign/i)
    // ordinary messages still go through
    await adapter.executeProtocolOperation('signMessage', { message: 'hello' })
    expect(signed).toEqual(['hello'])
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
