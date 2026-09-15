import { describe, expect, it } from 'vitest'
import { flattenArkadeConfig } from '../src/lib/arkade-sdk-wallet'

const storage = { walletRepository: {}, contractRepository: {} }

describe('flattenArkadeConfig', () => {
  it('reads settings nested under arkadeConfig', () => {
    // The shape Rate ships: everything but protocol/mnemonic/network nested.
    const flat = flattenArkadeConfig({
      protocol: 'ARKADE',
      network: 'signet',
      arkadeConfig: { arkServerUrl: 'https://ark.example', esploraUrl: 'https://esplora', storage },
    })

    expect(flat.arkServerUrl).toBe('https://ark.example')
    expect(flat.esploraUrl).toBe('https://esplora')
    // The one that matters: dropping it loses VTXO state on every restart.
    expect(flat.storage).toBe(storage)
  })

  it('reads settings at the top level', () => {
    const flat = flattenArkadeConfig({ arkServerUrl: 'https://ark.example', storage })

    expect(flat.arkServerUrl).toBe('https://ark.example')
    expect(flat.storage).toBe(storage)
  })

  it('prefers the top level when both carry a value', () => {
    const flat = flattenArkadeConfig({
      arkServerUrl: 'https://outer',
      arkadeConfig: { arkServerUrl: 'https://nested' },
    })

    expect(flat.arkServerUrl).toBe('https://outer')
  })

  it('covers every passthrough, not just the URLs', () => {
    const impl = class {}
    const flat = flattenArkadeConfig({
      arkadeConfig: {
        indexerUrl: 'https://indexer',
        swapProviderUrl: 'https://boltz',
        delegatorUrl: 'https://delegator',
        delegationEnabled: false,
        boltzSwapsEnabled: true,
        eventSource: impl,
        storage,
      },
    })

    expect(flat.indexerUrl).toBe('https://indexer')
    expect(flat.swapProviderUrl).toBe('https://boltz')
    expect(flat.delegatorUrl).toBe('https://delegator')
    expect(flat.delegationEnabled).toBe(false)
    expect(flat.boltzSwapsEnabled).toBe(true)
    expect(flat.eventSource).toBe(impl)
    expect(flat.storage).toBe(storage)
  })

  it('keeps an explicit false rather than falling through to the nested value', () => {
    const flat = flattenArkadeConfig({
      delegationEnabled: false,
      arkadeConfig: { delegationEnabled: true },
    })

    // `??` not `||`: opting out of delegation must not be read as "unset".
    expect(flat.delegationEnabled).toBe(false)
  })

  it('returns undefined for absent settings rather than throwing', () => {
    const flat = flattenArkadeConfig({})

    expect(flat.arkServerUrl).toBeUndefined()
    expect(flat.storage).toBeUndefined()
  })
})
