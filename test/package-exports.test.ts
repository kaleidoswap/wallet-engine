import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as root from '../src/index'
import * as lightning from '../src/lightning/index'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>
  peerDependenciesMeta: Record<string, { optional?: boolean }>
}

function resolveLocalModule(importer: string, specifier: string): string | undefined {
  const candidate = resolve(dirname(importer), specifier)
  for (const path of [candidate, `${candidate}.ts`, join(candidate, 'index.ts')]) {
    if (existsSync(path) && extname(path) === '.ts') return path
  }
  return undefined
}

function bareImports(entry: string): Set<string> {
  const pending = [entry]
  const visited = new Set<string>()
  const packages = new Set<string>()
  const importPattern = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g

  while (pending.length > 0) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]
      if (specifier.startsWith('.')) {
        const local = resolveLocalModule(file, specifier)
        if (local != null) pending.push(local)
      } else {
        packages.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])
      }
    }
  }
  return packages
}

describe('Lightning package exports', () => {
  it('wires the public root and ./lightning subpath to the same SDK-free contract', () => {
    expect(packageJson.exports['./lightning']).toEqual({
      types: './dist/lightning/index.d.ts',
      default: './dist/lightning/index.js',
    })
    expect(root.parseMsat).toBe(lightning.parseMsat)
    expect(root.validateBolt11Invoice).toBe(lightning.validateBolt11Invoice)
  })

  it('does not pull kaleido-sdk or any optional heavy peer into ./lightning', () => {
    const imports = bareImports(join(workspace, 'src/lightning/index.ts'))
    const optionalPeers = Object.entries(packageJson.peerDependenciesMeta)
      .filter(([, metadata]) => metadata.optional)
      .map(([name]) => name)

    expect([...imports].filter((name) => optionalPeers.includes(name))).toEqual([])
    expect(imports.has('kaleido-sdk')).toBe(false)
  })

  it('loads root and ./lightning through package self-reference in a plain Node consumer', () => {
    execFileSync(process.execPath, [join(workspace, 'test/fixtures/lightning-package-consumer.mjs')], {
      cwd: workspace,
      stdio: 'pipe',
    })
  })
})
