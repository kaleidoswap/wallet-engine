/**
 * Integration test setup
 * ----------------------
 * Runs once per test file before the suites (see `setupFiles` in
 * vitest.integration.config.ts).
 *
 * lwk shim: the Liquid adapter resolves `#lwk` to the Node build (`lwk_node`)
 * under Node, but some lwk code paths (a scan that needs to async-sleep and
 * retry) reach the wasm build's browser sleep, which throws
 * "Cannot access browser window for async sleep" when `window` is absent.
 * Provide a minimal `window`/`self` backed by Node's timers so that path works
 * headlessly. Harness-only — does not touch product code.
 *
 * NOTE: the fact that lwk can hit the browser sleep under Node at all is a
 * portability smell worth a separate look for pure-Node / RN hosts.
 */
const g = globalThis as unknown as Record<string, unknown>
if (typeof g.window === 'undefined') {
  g.window = g
}
if (typeof g.self === 'undefined') {
  g.self = g
}
