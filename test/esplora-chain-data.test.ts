import { describe, it, expect } from 'vitest'
import {
  EsploraChainDataProvider,
  parseEsploraOutspend,
  parseEsploraTransaction,
} from '../src/lib/esplora-chain-data'

const TXID = 'ab'.repeat(32)

function esploraTx(overrides: Record<string, unknown> = {}) {
  return {
    txid: TXID,
    vin: [{ txid: 'cd'.repeat(32), vout: 1, witness: ['AA', 'bb'] }],
    vout: [
      { scriptpubkey: '0014' + '11'.repeat(20), value: 1000 },
      { scriptpubkey: '5120' + '22'.repeat(32), valuecommitment: '08' + '33'.repeat(32) },
    ],
    status: { confirmed: true, block_height: 123 },
    ...overrides,
  }
}

function fakeFetch(routes: Record<string, { status?: number; body: string }>) {
  const seen: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    const route = routes[new URL(url).pathname]
    if (!route) return { ok: false, status: 404, body: null } as unknown as Response
    return {
      ok: (route.status ?? 200) < 300,
      status: route.status ?? 200,
      body: null,
      text: async () => route.body,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, seen }
}

describe('parseEsploraTransaction', () => {
  it('keeps explicit values, drops blinded ones, lowercases hex', () => {
    const tx = parseEsploraTransaction(esploraTx(), 'DEADBEEF\n', TXID)
    expect(tx).toEqual({
      txid: TXID,
      hex: 'deadbeef',
      vin: [{ txid: 'cd'.repeat(32), vout: 1, witness: ['aa', 'bb'] }],
      vout: [{ scriptPubKey: '0014' + '11'.repeat(20), valueSat: 1000 }, { scriptPubKey: '5120' + '22'.repeat(32) }],
      blockHeight: 123,
    })
  })

  it('leaves blockHeight undefined while unconfirmed', () => {
    const tx = parseEsploraTransaction(esploraTx({ status: { confirmed: false } }), '00', TXID)
    expect(tx.blockHeight).toBeUndefined()
  })

  it('rejects a body for a different txid', () => {
    expect(() => parseEsploraTransaction(esploraTx({ txid: 'ef'.repeat(32) }), '00', TXID)).toThrow(/returned transaction/)
  })

  it('rejects an output with neither value nor commitment, and non-integer values', () => {
    expect(() =>
      parseEsploraTransaction(esploraTx({ vout: [{ scriptpubkey: '00' }] }), '00', TXID)
    ).toThrow(/neither value nor valuecommitment/)
    expect(() =>
      parseEsploraTransaction(esploraTx({ vout: [{ scriptpubkey: '00', value: 1.5 }] }), '00', TXID)
    ).toThrow(/non-negative integer/)
    expect(() =>
      parseEsploraTransaction(esploraTx({ vout: [{ scriptpubkey: 'zz', value: 1 }] }), '00', TXID)
    ).toThrow(/not valid hex/)
  })

  it('rejects a confirmed status without a height', () => {
    expect(() => parseEsploraTransaction(esploraTx({ status: { confirmed: true } }), '00', TXID)).toThrow(
      /block_height/
    )
  })
})

describe('parseEsploraOutspend', () => {
  it('parses spent and unspent', () => {
    expect(parseEsploraOutspend({ spent: false })).toEqual({ spent: false })
    expect(parseEsploraOutspend({ spent: true, txid: TXID, vin: 2, status: {} })).toEqual({
      spent: true,
      txid: TXID,
      vin: 2,
    })
  })

  it('rejects a spent entry without its spender', () => {
    expect(() => parseEsploraOutspend({ spent: true })).toThrow(/outspend.txid/)
    expect(() => parseEsploraOutspend({})).toThrow(/malformed/)
  })
})

describe('EsploraChainDataProvider', () => {
  it('reads tip, transaction and outspend from the chain base URL', async () => {
    const { impl, seen } = fakeFetch({
      '/api/blocks/tip/height': { body: '820000\n' },
      [`/api/tx/${TXID}`]: { body: JSON.stringify(esploraTx()) },
      [`/api/tx/${TXID}/hex`]: { body: '0100' },
      [`/api/tx/${TXID}/outspend/0`]: { body: JSON.stringify({ spent: false }) },
    })
    const provider = new EsploraChainDataProvider({ bitcoinUrl: 'https://esplora.example/api/', fetch: impl })
    expect(provider.serves('bitcoin')).toBe(true)
    expect(provider.serves('liquid')).toBe(false)
    expect(await provider.tipHeight('bitcoin')).toBe(820000)
    expect((await provider.getTransaction('bitcoin', TXID))?.hex).toBe('0100')
    expect(await provider.getOutspend('bitcoin', TXID, 0)).toEqual({ spent: false })
    for (const { init } of seen) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
    }
  })

  it('returns null for an unknown transaction and rejects other HTTP failures', async () => {
    const { impl } = fakeFetch({
      [`/api/tx/${TXID}`]: { status: 500, body: 'boom' },
    })
    const provider = new EsploraChainDataProvider({ bitcoinUrl: 'https://esplora.example/api', fetch: impl })
    expect(await provider.getTransaction('bitcoin', 'ef'.repeat(32))).toBeNull()
    await expect(provider.getTransaction('bitcoin', TXID)).rejects.toThrow(/failed \(500\)/)
  })

  it('rejects a chain it has no URL for, a malformed tip and a bad txid', async () => {
    const { impl } = fakeFetch({ '/api/blocks/tip/height': { body: 'soon' } })
    const provider = new EsploraChainDataProvider({ bitcoinUrl: 'https://esplora.example/api', fetch: impl })
    await expect(provider.tipHeight('liquid')).rejects.toThrow(/No Esplora URL configured for the liquid chain/)
    await expect(provider.tipHeight('bitcoin')).rejects.toThrow(/tip height is malformed/)
    await expect(provider.getTransaction('bitcoin', 'nope')).rejects.toThrow(/not valid hex/)
  })

  it('refuses base URLs with credentials or a non-HTTP scheme', () => {
    expect(() => new EsploraChainDataProvider({ bitcoinUrl: 'https://u:p@esplora.example/api' })).toThrow(/credentials/)
    expect(() => new EsploraChainDataProvider({ liquidUrl: 'ftp://esplora.example/api' })).toThrow(/HTTP/)
  })
})
