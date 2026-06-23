# Changelog

All notable changes to `@kaleidorg/wallet-engine` are documented here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/) (currently in a
`1.0.0-beta` pre-release line).

## [Unreleased]

### Security
- **Destination classifier hardened to fail closed.** Matchers are now strict and
  anchored: arbitrary text (e.g. `Hello`, `VToken`, `not-an-address`) no longer
  misclassifies as a Liquid/BTC destination. Ambiguous legacy base58 Liquid
  prefixes were dropped, and `LIQUID` was removed from on-chain BTC candidate
  lists (it cannot settle a Bitcoin L1 address).
- **Router `direct`/`best` verified against the capability manifest.** A route is
  only marked directly payable when the protocol actually supports the
  destination's surface; `best` is always a genuinely-direct route or `null`.
- **`executeProtocolOperation` gated by per-adapter allowlists.** Caller-supplied
  operation strings can no longer reach arbitrary account methods or prototype
  members (`constructor`, `__proto__`, …).
- **Money coercion guards.** Swap amount fields fail closed on non-finite values
  or magnitudes past `Number.MAX_SAFE_INTEGER`; parsed receive amounts reject
  `NaN`/negative/non-finite.
- Pinned `optionalDependencies` (`@arkade-os/sdk`, `@buildonspark/spark-sdk`,
  `@flashnet/sdk`) from floating `"*"` to caret ranges.

### Added
- **RGB-L1 protocol** — a new `RGB_L1` protocol type and `RgbLibWdkAdapter`
  backed by local rgb-lib (`@utexo/wdk-wallet-rgb`): on-chain BTC + RGB assets,
  no Lightning/channels/swaps. Described once in the capability manifest; the
  router, unified receive, and lite aggregation pick it up with no other changes.
  Opt-in (not in `createWdkRegistry`'s default set; install `@utexo/wdk-wallet-rgb`
  separately). The node-backed `RGB` (RGB-LN) path is unchanged.
- `receiveMethodsOf(params)` — enumerate the payment methods present in a unified
  receive URI so consumers can surface a choice instead of auto-paying one.
- Test safety net for the pure core (destination classifier, disclosure, bolt11,
  unified receive, router, RGB translation, swap amount guards, escape hatches).
- CI now runs the test suite (Node 20 & 22) and a production-dependency audit.
- `SECURITY.md`, `CONTRIBUTING.md`, and `examples/minimal-adapter`.

### Changed
- Introduced `BaseWdkAdapter` — the five WDK adapters (Spark, Liquid, RGB/RLN,
  RGB-L1, Arkade) now share connection lifecycle (`isConnected`/`disconnect`),
  the connected-guard, `supportsSwaps`, `version`, and the allowlisted escape
  hatch, removing ~170 lines of duplicated boilerplate. Native adapters untouched.
- Extracted shared, transport-agnostic RGB translation helpers into
  `adapters/wdk/RgbCore.ts` (one source of truth for RGB asset/balance/status
  mapping; reused by the node-backed adapter and future RGB-L1 adapter).
- `KaleidoswapSwap` now uses thin typed response shapes so a renamed/missing
  money field is a compile error rather than a silent `NaN`; the executed `price`
  is carried through `executeSwap` (previously dropped to `0`).
- `ProtocolManager.findAsset` runs connected adapters in parallel with a
  per-protocol timeout; `withTimeout` clears its timer on settle.

## [1.0.0-beta.12]
- Renamed the package to `@kaleidorg/wallet-engine` (from
  `@kaleidorg/wallet-protocols`).

## [1.0.0-beta.11]
- Ported rate-extension's `ProtocolManager` hardening.

## [1.0.0-beta.10]
- Emit Node-ESM-valid relative import specifiers in the build.

## [1.0.0-beta.9] and earlier
- Adapter-free main barrel with opt-in sub-path exports; `kaleido-sdk` as an
  optional peer; real platform-port seam + injectable logger; contract superset
  and `RgbConfig` reconciliation. See git history for details.
