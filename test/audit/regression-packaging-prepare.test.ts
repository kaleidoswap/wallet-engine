/*
 * Regression test for the packaging finding (REPORT-2.md §4.2, "Packaging",
 * which replaced run 1's rejected G-F18).
 *
 * `dist/` is correctly gitignored and built at publish time by
 * `prepublishOnly`. That covers the registry tarball. It does NOT cover a git
 * dependency — npm runs `prepare`, never `prepublishOnly`, when staging
 * `npm install git+https://…/wallet-engine`. Without a `prepare` hook the
 * staged tree contains no `dist/`, `files: ["dist"]` packs nothing, and every
 * entry in `exports` resolves to a missing file.
 *
 * Measured at parent df6…9a8e581 (see the commit message for the transcript):
 *   $ npm install "git+file:///…/wallet-engine#audit/security-2026-08-30"
 *   added 13 packages …
 *   $ ls node_modules/@kaleidorg/wallet-engine/
 *   LICENSE  README.md  package.json          <- no dist/
 *   $ node -e "import('@kaleidorg/wallet-engine')"
 *   ERR_MODULE_NOT_FOUND … /dist/index.js
 *
 * This test pins the invariant that makes that possible: every published entry
 * point is a build output (not tracked in git), so SOMETHING must build it at
 * install time. If a future change adds an export whose file is generated, this
 * still holds; if the `prepare` hook is dropped, this fails.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

/** Every relative path package.json publishes as an entry point. */
function entryPoints(): string[] {
  const out = new Set<string>()
  for (const key of ['main', 'module', 'types', 'bin'] as const) {
    const v = pkg[key]
    if (typeof v === 'string') out.add(v)
    else if (v && typeof v === 'object') for (const p of Object.values(v)) out.add(p as string)
  }
  const walk = (node: unknown): void => {
    if (typeof node === 'string') out.add(node)
    else if (node && typeof node === 'object') Object.values(node).forEach(walk)
  }
  walk(pkg.exports ?? {})
  // `./package.json` is the one export that is a source file, not a build output.
  out.delete('./package.json')
  return [...out].map((p) => p.replace(/^\.\//, ''))
}

describe('packaging: a git install must produce dist/', () => {
  it('declares a `prepare` hook', () => {
    // `prepare` is the ONLY lifecycle npm runs when staging a git dependency.
    // `prepublishOnly` does not run there, so it cannot cover this case.
    expect(pkg.scripts?.prepare, 'package.json scripts.prepare').toBeTruthy()
  })

  it('every published entry point is a build output, so the install must build', () => {
    const entries = entryPoints()
    expect(entries.length).toBeGreaterThan(0)

    // Not one of them is tracked in git: the git-staged tree has none of these
    // files, which is precisely why a build hook is mandatory rather than nice
    // to have.
    const tracked = execFileSync('git', ['ls-files', '--', ...entries], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
    expect(tracked, 'entry points are gitignored build outputs').toEqual([])

    // And each is covered by `files`, so the build output actually gets packed.
    const files: string[] = pkg.files ?? []
    for (const entry of entries) {
      expect(
        files.some((f) => entry === f || entry.startsWith(f.replace(/\/$/, '') + '/')),
        `${entry} is covered by package.json "files"`,
      ).toBe(true)
    }
  })
})
