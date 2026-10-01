import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * Integration (live network) test config. Separate from the unit config so the
 * default `npm test` never touches the network. Run with:
 *
 *   npm run test:integration
 *
 * Loads `test/integration/.env` (if present) into `process.env` so the suites
 * can pick up ALICE_MNEMONIC / BOB_MNEMONIC and per-network endpoints. Every
 * suite still self-skips when its config is missing.
 */
export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, 'test/integration', ''))
  // `@arkade-os/sdk` settles through the Ark server's event stream, so a runtime
  // without `EventSource` cannot renew a VTXO — it expires and the server sweeps
  // it (#83). Node has it only behind this flag. Set on the env rather than
  // `poolOptions.execArgv`, which the workers do not pick up; they inherit this.
  // Without it one wallet logged 115 errors in a 65-second poll window, against
  // 1 with it. The suite has to run the way a host that keeps its funds runs.
  if (!/--experimental-eventsource/.test(process.env.NODE_OPTIONS ?? '')) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --experimental-eventsource`.trim()
  }
  return {
    test: {
      environment: 'node',
      include: ['test/integration/**/*.integration.test.ts'],
      // Live network calls are slow; give suites room and don't run them in parallel
      // (shared test-network state, rate limits, and rgb-lib SQLite dirs).
      testTimeout: 120_000,
      hookTimeout: 240_000,
      fileParallelism: false,
    },
  }
})
