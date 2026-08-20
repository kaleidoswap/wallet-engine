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
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, { optional?: boolean }>
  devDependencies: Record<string, string>
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

  it('exposes concrete adapters only through SDK-coupled opt-in subpaths at the verified floor', () => {
    expect(packageJson.exports['./lightning/nwc']).toEqual({
      types: './dist/lightning/nwc/index.d.ts',
      default: './dist/lightning/nwc/index.js',
    })
    expect(packageJson.exports['./lightning/rln']).toEqual({
      types: './dist/lightning/rln/index.d.ts',
      default: './dist/lightning/rln/index.js',
    })
    expect(bareImports(join(workspace, 'src/lightning/nwc/index.ts')).has('kaleido-sdk')).toBe(true)
    expect(bareImports(join(workspace, 'src/lightning/rln/index.ts')).has('kaleido-sdk')).toBe(true)
    expect(packageJson.peerDependencies['kaleido-sdk']).toBe('^0.1.18')
    expect(packageJson.devDependencies['kaleido-sdk']).toBe('^0.1.18')
    expect(packageJson.peerDependenciesMeta['kaleido-sdk']).toEqual({ optional: true })
  })

  it('loads root, ./lightning, and both adapters through package self-reference in a plain Node consumer', () => {
    execFileSync(process.execPath, [join(workspace, 'test/fixtures/lightning-package-consumer.mjs')], {
      cwd: workspace,
      stdio: 'pipe',
    })
  })
})
