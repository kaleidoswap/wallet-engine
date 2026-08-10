import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from 'vitest'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('Lightning adapter consumer types', () => {
  it('type-checks the SDK-free contract and opt-in adapter subpaths by package self-reference', () => {
    execFileSync(
      join(workspace, 'node_modules/.bin/tsc'),
      ['-p', join(workspace, 'test/fixtures/tsconfig.lightning-contract.json')],
      { cwd: workspace, stdio: 'pipe' },
    )
  })
})
