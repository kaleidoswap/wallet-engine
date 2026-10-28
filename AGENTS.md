# AGENTS.md

Instructions for coding agents (Claude Code, Cursor, Codex, …) working in this
repo or building on `@kaleidorg/wallet-engine`. Humans want
[CONTRIBUTING.md](CONTRIBUTING.md) and the [README](README.md).

## What this package is

A headless multi-protocol Bitcoin L2 wallet engine. One `IProtocolAdapter`
contract over BTC, Spark, RGB-LN, RGB-L1, Liquid and Arkade, plus the four
cross-protocol primitives: `CrossProtocolRouter`, BIP321 unified receive, the
capability manifest, and lite/advanced disclosure.

Verify the shape before you write against it — one command, no network:

```bash
npm install && npm run example:tour
```

## This repository is public: fix security bugs without disclosing them

Everything pushed here, including pull-request titles and bodies, commit
messages, issues, comments and `CHANGELOG.md`, is visible to anyone the moment
it lands, and the npm package lags `main`, so a merged fix is not a shipped
fix. Until a release that contains the fix is published, a public description
of the bug is an exploit guide for every current user.

1. **Check visibility before any outward-facing action**
   (`gh repo view --json visibility`). Assume public.
2. **Never publish, anywhere public, before the fixed release exists:** a
   reference to an unpublished security review or audit, finding numbers or
   severity ratings, exploit or attack scenarios, or anything else that
   explains how to abuse an unpatched version. This includes PR bodies,
   commit messages, code comments, test names and the `[Unreleased]`
   changelog.
3. **Describe the change neutrally:** what is now validated or refused, not
   what an attacker could do.
4. **Prefer the private path for anything exploitable:** a GitHub security
   advisory with a temporary private fork, or a branch the maintainer agrees
   to merge and release promptly. Release first; the maintainer publishes the
   advisory with the full write-up afterwards.
5. **When in doubt, stop and ask the maintainer** before pushing or opening
   anything. GitHub keeps edit history, so a disclosure cannot be undone.
6. **Pass these rules on explicitly** when delegating to subagents.

## Non-negotiable invariants

Violating any of these is a bug even if it type-checks and tests pass.

1. **Never branch on a protocol name.** No `if (protocol === 'SPARK')` outside an
   adapter. Protocol differences are data in
   [`src/capabilities/index.ts`](src/capabilities/index.ts) — read the flag, add
   one if it's missing.
2. **Never add a method to `IProtocolAdapter` for a single protocol.** Add a
   capability flag, or a capability-group interface (`IRgbOperations`,
   `ISparkOperations`, …) narrowed with `asRgbOperations(adapter)`.
3. **The root barrel stays SDK-free.** [`src/index.ts`](src/index.ts) must not
   import a protocol SDK, directly or transitively — an MV3 extension host
   imports it and cannot carry that weight. Adapters live behind their own
   subpath exports and lazy-load their SDK inside `connect()`.
4. **No SDK types cross the contract.** Adapters translate their backing SDK's
   shapes into the domain types in `src/types/`. SDK objects may be `any` inside
   an adapter; only domain types leave it.
5. **The engine never touches platform APIs.** No `localStorage`, `chrome.*`,
   `crypto.getRandomValues`, `Date.now()` at module scope — go through the
   injected ports in [`src/ports/index.ts`](src/ports/index.ts).
6. **Protocol SDKs are optional `peerDependencies`.** Never promote one to a
   `dependency`. A host installs only the adapters it uses.
7. **The engine never moves funds implicitly.** A method that would broadcast or
   fund something the caller didn't explicitly ask for is wrong — return the
   amounts and the address, and let the host send.

## Adding a protocol — the whole recipe

1. Copy [`examples/minimal-adapter/MemoAdapter.ts`](examples/minimal-adapter/MemoAdapter.ts)
   — the complete contract in ~170 dependency-free lines.
2. Implement `ICoreProtocolAdapter` plus whichever capability groups apply
   (`implements ICoreProtocolAdapter & IRgbOperations` gives you required rather
   than optional methods).
3. Add **one** entry to `PROTOCOL_CAPABILITIES` in
   [`src/capabilities/index.ts`](src/capabilities/index.ts) — layers, quirks,
   `wdkModule`, `maturity` — and one to
   [`src/capabilities/operations.ts`](src/capabilities/operations.ts).
4. If the destination format is new, add it to
   [`src/router/destination.ts`](src/router/destination.ts) with its candidate
   protocols.
5. Register it: `manager.registerAdapter(new MyAdapter())`, or add it to
   `createWdkRegistry`.

Router, unified receive, lite aggregation and every consuming screen pick it up
with **zero** changes to existing protocol code. If your change required editing
another protocol's path, the design was circumvented — reconsider it.

## Testing

```bash
npm run build   # tsc — must stay clean, no new `any` on money-carrying boundaries
npm test        # vitest, 359 tests
```

Pure modules (router, disclosure, receive, capabilities) must stay fully covered.
`npm run test:integration` hits live nodes and needs env mnemonics — do not run it
unprompted, and never with mainnet funds.

## Repo conventions

- ESM only, `.js` extensions in relative imports (the build rewrites them).
- Comments explain *why*, not *what*, and stay terse — a line or two. Don't
  narrate obvious code, restate the SDK's own docs, or inline API listings that
  drift; a load-bearing quirk or a fail-closed rationale is worth keeping, at
  the shortest length that still carries it.
- Releases: tag → `publish.yml`. Moving a dist-tag is a separate manual
  `dist-tag.yml` dispatch, never `npm publish`.
