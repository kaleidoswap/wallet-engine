import { describe, it, expect } from 'vitest'
import { BaseWdkAdapter } from '../src/adapters/wdk/BaseWdkAdapter'
import type { ProtocolType } from '../src/types/base'

const OPS = new Set(['allowedOp'])

/** Minimal concrete subclass to exercise the shared base behavior directly. */
class TestAdapter extends BaseWdkAdapter {
  readonly protocolName: ProtocolType = 'RGB_L1'
  setAccount(account: any) {
    this.account = account
    this.connected = true
  }
  guard() {
    this.assertConnected()
  }
  run(op: string, params: unknown) {
    return this.runAllowlistedOp(OPS, op, params)
  }
}

describe('BaseWdkAdapter', () => {
  it('isConnected reflects state; assertConnected throws until connected', () => {
    const a = new TestAdapter()
    expect(a.isConnected()).toBe(false)
    expect(() => a.guard()).toThrow(/not connected/i)
    a.setAccount({})
    expect(a.isConnected()).toBe(true)
    expect(() => a.guard()).not.toThrow()
  })

  it('disconnect disposes account + manager and resets state', async () => {
    const a = new TestAdapter()
    const disposed: string[] = []
    Object.assign(a as any, {
      connected: true,
      account: { dispose: () => disposed.push('account'), cleanupConnections: () => disposed.push('cleanup') },
      manager: { dispose: () => disposed.push('manager') },
    })
    await a.disconnect()
    expect(disposed).toEqual(['account', 'cleanup', 'manager'])
    expect(a.isConnected()).toBe(false)
  })

  it('defaults version and exposes supportsSwaps from the manifest (RGB_L1 = false)', () => {
    const a = new TestAdapter()
    expect(a.version).toBe('0.1.0-wdk')
    expect(a.supportsSwaps()).toBe(false)
  })

  it('runAllowlistedOp dispatches allowed ops and rejects everything else', async () => {
    const a = new TestAdapter()
    a.setAccount({ allowedOp: async (p: any) => ['ok', p], changePassword: async () => 'nope' })
    expect(await a.run('allowedOp', { x: 1 })).toEqual(['ok', { x: 1 }])
    await expect(a.run('changePassword', {})).rejects.toThrow(/not allowed/i)
    await expect(a.run('constructor', {})).rejects.toThrow(/not allowed/i)
  })
})
