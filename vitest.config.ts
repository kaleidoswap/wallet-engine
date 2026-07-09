import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Live network suites are opt-in — run them via `npm run test:integration`
    // (see vitest.integration.config.ts). They must never run in the unit CI.
    exclude: ['test/integration/**', 'node_modules/**'],
  },
})
