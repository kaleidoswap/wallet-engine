import { describe, expect, it } from 'vitest'
import { bech32m } from '@scure/base'
import { ArkAddress, isValidArkAddress } from '@arkade-os/sdk'

/**
 * Two Arks, one prefix.
 *
 * Arkade and bark (Second) both mint `ark1`/`tark1` addresses, so the HRP
 * cannot say which network an address belongs to — and sending to the wrong
 * server is a loss, not an error. The payloads do differ, and each SDK's
 * validator rejects the other's, which is what the adapters route on.
 *
 * Pinned here because it is a property of two third-party encodings: if either
 * changes its layout, this fails before a user's money does.
 */

// From a bark wallet on ark.signet.2nd.dev.
const BARK_ADDRESS =
  'tark1pem36wcfzqqpc0zgce9q3jqgnt3t7w54dz6gtzddt9awugjx25uduq7fnzvvvzvezqyp82sv47phqky46zwd44dfzy3m9uvqztvza9ljmnd583e7wztchvwqpjpewg'

function payloadLength(address: string): number {
  const decoded = bech32m.decode(address as `${string}1${string}`, 1023)
  return bech32m.fromWords(decoded.words).length
}

describe('ark address disambiguation', () => {
  const arkadeAddress = new ArkAddress(
    Uint8Array.from({ length: 32 }, (_, i) => i + 1),
    Uint8Array.from({ length: 32 }, (_, i) => i + 9),
    'tark',
  ).encode()

  it('gives both networks the same human-readable prefix', () => {
    expect(BARK_ADDRESS.startsWith('tark1')).toBe(true)
    expect(arkadeAddress.startsWith('tark1')).toBe(true)
  })

  it('separates them by payload: 65 bytes for Arkade, 75 for bark', () => {
    expect(payloadLength(arkadeAddress)).toBe(65)
    expect(payloadLength(BARK_ADDRESS)).toBe(75)
  })

  it("refuses bark's address through the Arkade SDK", () => {
    expect(isValidArkAddress(arkadeAddress)).toBe(true)
    expect(isValidArkAddress(BARK_ADDRESS)).toBe(false)
    expect(() => ArkAddress.decode(BARK_ADDRESS)).toThrow(/length/i)
  })
})
