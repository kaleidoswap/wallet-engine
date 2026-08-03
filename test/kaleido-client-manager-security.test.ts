import { afterEach, describe, expect, it } from 'vitest'
import { kaleidoClientManager } from '../src/lib/kaleido-client-manager'

afterEach(() => kaleidoClientManager.reset())

describe('KaleidoClientManager secret handling', () => {
  it('redacts bearer and NWC credentials from config reads', () => {
    kaleidoClientManager.initialize({
      baseUrl: 'https://maker.example',
      nodeUrl: 'https://node.example',
      apiKey: 'bearer-secret',
      nwcUri: 'nostr+walletconnect://client?secret=nwc-secret',
    })

    expect(kaleidoClientManager.getConfig()).toEqual({
      baseUrl: 'https://maker.example',
      nodeUrl: 'https://node.example',
      apiKey: undefined,
      nwcUri: undefined,
    })
  })
})
