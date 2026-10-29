import { describe, expect, it } from 'vitest'
import { stripLightningScheme } from '../src/lib/lightning-uri'

/** One `lightning:` normalisation shared by the spend policy and the adapters (finding 13). */
describe('stripLightningScheme', () => {
  it('drops the scheme case-insensitively and trims around it', () => {
    expect(stripLightningScheme('lightning:lnbc1abc')).toBe('lnbc1abc')
    expect(stripLightningScheme('LIGHTNING:lnbc1abc')).toBe('lnbc1abc')
    expect(stripLightningScheme('Lightning:LNBC1ABC')).toBe('LNBC1ABC')
    expect(stripLightningScheme('  lightning: lnbc1abc \n')).toBe('lnbc1abc')
  })

  it('leaves bare invoices, addresses and empty input alone', () => {
    expect(stripLightningScheme('lnbc1abc')).toBe('lnbc1abc')
    expect(stripLightningScheme(' bc1qaddress ')).toBe('bc1qaddress')
    expect(stripLightningScheme('')).toBe('')
    expect(stripLightningScheme(undefined)).toBe('')
  })

  it('strips one scheme only, so a smuggled double prefix still fails to decode', () => {
    expect(stripLightningScheme('lightning:lightning:lnbc1abc')).toBe('lightning:lnbc1abc')
  })
})
