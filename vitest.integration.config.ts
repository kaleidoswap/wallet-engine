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
  return {
    test: {
      environment: 'node',
      setupFiles: ['test/integration/setup.ts'],
      include: ['test/integration/**/*.integration.test.ts'],
      // Live network calls are slow; give suites room and don't run them in parallel
      // (shared test-network state, rate limits, and rgb-lib SQLite dirs).
      testTimeout: 120_000,
      hookTimeout: 240_000,
      fileParallelism: false,
    },
  }
})
