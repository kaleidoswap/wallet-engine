/**
 * `EventSource` availability for the Arkade SDK.
 *
 * The SDK needs the server's event stream to COMPLETE a settle, not just to
 * observe one, so a runtime without `EventSource` renews no VTXO and the server
 * sweeps them at batch expiry — while the adapter still reports `connected`.
 * Browsers and React Native have the global; Node has it only behind
 * `--experimental-eventsource`, which a library cannot set for its host.
 */

type GlobalWithEventSource = { EventSource?: unknown }

/**
 * Install `injected` as `globalThis.EventSource` if there is none, and report
 * whether the SDK will find one. The SDK reads the global directly, so that is
 * where it has to go; an existing implementation is never overwritten.
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

export const EVENT_SOURCE_MISSING_REASON =
  'Arkade settlement is disabled: this runtime has no global EventSource, which @arkade-os/sdk needs to complete a settle(). ' +
  'VTXOs will not be renewed and will be swept by the server at batch expiry. ' +
  'Run Node with --experimental-eventsource, or pass ArkadeConfig.eventSource with an implementation.'
