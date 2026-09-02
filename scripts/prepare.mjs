/*
 * npm `prepare` hook.
 *
 * `dist/` is gitignored and built at publish time by `prepublishOnly`. That
 * covers the registry tarball, but NOT a git dependency: npm never runs
 * `prepublishOnly` for `npm install git+https://…/wallet-engine`, so a consumer
 * installing this package from git got a tree with no `dist/` at all and every
 * entry in `exports` resolved to a missing file (ERR_MODULE_NOT_FOUND on the
 * very first import). `prepare` is the hook npm DOES run for a git dependency —
 * it installs devDependencies into the staging clone, runs `prepare`, then packs
 * `files: ["dist"]`.
 *
 * `prepare` also fires on a plain `npm install` inside this repo (contributor
 * setup) — which is harmless and keeps a fresh clone importable — and on
 * `npm pack`/`npm publish` before `prepublishOnly`. It does NOT fire for a
 * consumer installing the published tarball, so registry installs are unaffected.
 *
 * The build is skipped when TypeScript is absent. That is the
 * `npm install --omit=dev` / CI-consumer case: there is nothing to build with,
 * and failing the hook there would break an install that has no need of a build
 * (the tarball already ships `dist/`). Any OTHER build failure is propagated —
 * a git install that silently produced no `dist/` is exactly the bug this fixes.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

try {
  require.resolve('typescript/package.json')
} catch {
  console.log('[prepare] typescript not installed — skipping build (production install)')
  process.exit(0)
}

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    process.exit(r.status ?? 1)
  }
}

run(process.execPath, [require.resolve('typescript/bin/tsc')])
run(process.execPath, ['scripts/fix-esm-extensions.mjs'])
