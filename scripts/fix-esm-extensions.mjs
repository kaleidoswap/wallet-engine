/**
 * Post-build: rewrite extensionless relative imports/exports in the emitted
 * dist to explicit `.js` (or `/index.js`) specifiers.
 *
 * tsc with moduleResolution:"bundler" emits relative specifiers exactly as
 * written (extensionless), which Node's ESM resolver rejects. Bundlers (Vite/
 * esbuild/Metro) infer extensions, but Node and vitest's externalized-dep path
 * do not — so the package must ship valid ESM. This makes it consumable
 * everywhere without forcing a NodeNext migration of the source tree.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

/** Collect .js and .d.ts files under dist. */
function collect(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collect(full))
    else if (full.endsWith('.js') || full.endsWith('.d.ts')) out.push(full)
  }
  return out
}

// Matches `from '<spec>'` and `import('<spec>')` for relative specifiers.
const SPEC = /(\bfrom\s*['"]|\bimport\s*\(\s*['"])(\.\.?\/[^'"]*)(['"])/g

let changed = 0
for (const file of collect(DIST)) {
  const dir = dirname(file)
  const code = readFileSync(file, 'utf8')
  const next = code.replace(SPEC, (m, pre, spec, post) => {
    if (/\.(js|json|mjs|cjs)$/.test(spec)) return m // already has an extension
    if (existsSync(resolve(dir, spec + '.js'))) return `${pre}${spec}.js${post}`
    if (existsSync(resolve(dir, spec, 'index.js')))
      return `${pre}${spec.replace(/\/$/, '')}/index.js${post}`
    return m // leave untouched if neither exists
  })
  if (next !== code) {
    writeFileSync(file, next)
    changed++
  }
}
console.log(`fix-esm-extensions: rewrote ${changed} file(s) in dist`)
