/**
 * Pins the RLN node-auth contract with the resolved kaleido-sdk.
 *
 * The node credential is a full-custody bearer token: whoever holds it can
 * move funds on the RLN node. It reaches the node only if the SDK carries it,
 * and the SDK's config for that is `nodeApiKey`, which exists from 0.1.16.
 *
 * The failure this guards is silent. An unknown extra property on a JS object
 * literal is dropped at runtime with no error and no log, so against an older
 * SDK every RLN request would go out with no `Authorization` header while
 * `KaleidoClientManager.initialize` still reported a healthy client — the only
 * way to notice is to inspect the wire. `sdkSupportsNodeAuth` below turns that
 * into a compile error, and the runtime case asserts the manager actually
 * forwards the credential rather than swallowing it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KaleidoClient } from 'kaleido-sdk'
import { kaleidoClientManager } from '../src/lib/kaleido-client-manager'

type SdkConfig = Parameters<typeof KaleidoClient.create>[0]

/**
 * Compile-time assertion: the resolved SDK accepts the node-scoped credential.
 * `tsc` fails here on kaleido-sdk < 0.1.16 — which is exactly the resolution
 * the SDK floor exists to forbid. The current 0.1.17 floor also supplies the
 * opt-in `/nwc` and `/rln` exports.
 */
const sdkSupportsNodeAuth: SdkConfig = { nodeApiKey: 'compile-time-probe' }

afterEach(() => {
  kaleidoClientManager.reset()
  vi.restoreAllMocks()
})

describe('RLN node auth', () => {
  it('the resolved kaleido-sdk accepts a node-scoped credential', () => {
    expect(sdkSupportsNodeAuth.nodeApiKey).toBe('compile-time-probe')
  })

  it('forwards the node credential as nodeApiKey, never as the maker apiKey', () => {
    const create = vi.spyOn(KaleidoClient, 'create')

    kaleidoClientManager.initialize({
      baseUrl: 'https://maker.example',
      nodeUrl: 'https://node.example',
      apiKey: 'node-bearer-secret',
    })

    expect(create).toHaveBeenCalledTimes(1)
    const passed = create.mock.calls[0][0]
    expect(passed.nodeApiKey).toBe('node-bearer-secret')
    // The maker API is public; sending the node's custody credential there
    // would leak it to a different trust domain.
    expect(passed.apiKey).toBeUndefined()
  })

  it('omits the credential when none is configured', () => {
    const create = vi.spyOn(KaleidoClient, 'create')

    kaleidoClientManager.initialize({
      baseUrl: 'https://maker.example',
      nodeUrl: 'https://node.example',
    })

    const passed = create.mock.calls[0][0]
    expect(passed.nodeApiKey).toBeUndefined()
    expect(passed.apiKey).toBeUndefined()
  })
})
