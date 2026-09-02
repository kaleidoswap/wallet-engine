import { describe, it, expect } from 'vitest'
import { buildUnifiedReceiveURI, parseUnifiedReceiveURI, receiveMethodsOf } from '../../src/receive/unifiedReceive'

/**
 * Audit finding O4 — every field except the address went through
 * `URLSearchParams` (percent-encoded); the address was interpolated raw. An
 * address containing `?` or `&` therefore injected payment rails into the
 * wallet's own receive QR and swallowed the caller's `amount`.
 */
describe('O4: buildUnifiedReceiveURI must not let the address inject query params', () => {
  it('an address containing ? does not inject a lightning rail', () => {
    const uri = buildUnifiedReceiveURI({ btcAddress: 'bc1qGOOD?lightning=lnbcATTACKER', amountBtc: 0.001 })
    const back = parseUnifiedReceiveURI(uri)!
    expect(back.lightningInvoice, 'no lightning rail may appear').toBeUndefined()
    expect(back.amountBtc, 'the caller amount must survive').toBe(0.001)
    expect(receiveMethodsOf(back)).toEqual(['btcAddress'])
  })

  it('an address containing & does not inject a rail', () => {
    const uri = buildUnifiedReceiveURI({ btcAddress: 'bc1qGOOD&spark=spark1ATTACKER', amountBtc: 0.5 })
    const back = parseUnifiedReceiveURI(uri)!
    expect(back.sparkAddress).toBeUndefined()
    expect(back.amountBtc).toBe(0.5)
  })

  it('the output always round-trips its own input', () => {
    for (const addr of [
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      'bc1qGOOD?lightning=lnbcATTACKER',
      'weird address with spaces',
      'a#b',
      '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
    ]) {
      const back = parseUnifiedReceiveURI(buildUnifiedReceiveURI({ btcAddress: addr, amountBtc: 0.002 }))!
      expect(back.btcAddress, `round-trip ${addr}`).toBe(addr)
      expect(back.amountBtc, `amount survives ${addr}`).toBe(0.002)
    }
  })

  it('normal URIs are byte-for-byte unchanged (no gratuitous escaping)', () => {
    expect(buildUnifiedReceiveURI({ btcAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amountBtc: 0.001 }))
      .toBe('bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.001')
    expect(buildUnifiedReceiveURI({ lightningInvoice: 'lnbc1pvjluez' }))
      .toBe('bitcoin:?lightning=lnbc1pvjluez')
  })
})
