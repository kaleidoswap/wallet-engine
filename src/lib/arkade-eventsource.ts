/**
 * `EventSource` availability for the Arkade SDK.
 *
 * `@arkade-os/sdk` reaches the Ark server's event stream through the global
 * `EventSource`, and it needs that stream to *settle* — not merely to observe.
 * `settle()` registers an intent and then waits on round events, so without the
 * global the SDK's periodic settle throws `EventSource is not defined` on every
 * poll, no VTXO is ever renewed, and the batch expiry arrives and the server
 * sweeps the funds. That is not a degraded subscription; it is silent, dated
 * fund loss that a host cannot see, because the adapter still reports
 * `connected: true` throughout.
 *
 * Browsers and React Native have the global. Node does not: it is behind
 * `--experimental-eventsource` (Node 22.3+/24), which a library cannot turn on
 * for its host. So a Node host must either run with that flag or hand us an
 * implementation — `eventsource` from npm, `undici`'s, its own — through
 * `ArkadeConfig.eventSource`.
 *
 * Measured on mutinynet, one wallet over a 65-second poll window: 115 errors
 * without it (57 subscription failures, 57 bare throws, and the settle) against
 * 1 with it, and that one a round-timing error that retries.
 */

/** Globals we may read or install onto, without assuming a DOM lib. */
type GlobalWithEventSource = { EventSource?: unknown }

/**
 * Make sure `globalThis.EventSource` exists, installing `injected` if it does
 * not, and report whether the Arkade SDK will find one.
 *
 * Installing onto the global is the SDK's own lookup, not a choice we get to
 * make — it reads the global directly. We only do it when the host passed an
 * implementation, and never overwrite one that is already there.
 */
export function ensureEventSource(injected?: unknown): boolean {
  const scope = globalThis as GlobalWithEventSource
  if (typeof scope.EventSource === 'function') return true
  if (typeof injected === 'function') {
    scope.EventSource = injected
    return true
  }
  return false
}

/** One-line explanation of what a host loses, and the two ways to fix it. */
export const EVENT_SOURCE_MISSING_REASON =
  'Arkade settlement is disabled: this runtime has no global EventSource, which @arkade-os/sdk needs to complete a settle(). ' +
  'VTXOs will not be renewed and will be swept by the server at batch expiry. ' +
  'Run Node with --experimental-eventsource, or pass ArkadeConfig.eventSource with an implementation.'
