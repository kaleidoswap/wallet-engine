# Changelog

All notable changes to `@kaleidorg/wallet-engine` are documented here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/) (currently in a
`1.0.0-beta` pre-release line).

## [Unreleased]

## [1.0.0-beta.18] - 2026-06-26

### Fixed
- **RgbLibWasmAdapter: map signet → `SignetCustom` (Mutinynet).** KaleidoSwap's
  signet is the custom signet (Mutinynet); its recipient IDs are network-tagged
  `SignetCustom` and won't validate against a standard `Signet` wallet (RLN
  rejected sends with "recipient ID is for a different network"). `toRgbNetwork`
  now maps `signet` (and the `signetcustom`/`customsignet`/`mutinynet` aliases)
  to rgb-lib's `SignetCustom`.

## [1.0.0-beta.17] - 2026-06-26

### Fixed
- **`RgbLibWasmAdapter.getReceiveAddress` returned an empty BTC address.** A
  truthy `"BTC"` asset id was treated as RGB (blinded invoice) → empty
  `BTC_ADDRESS` / "bitcoin:" QR. Only `rgb:…` ids now produce a blinded invoice;
  `"BTC"`/empty return the on-chain `getAddress()`.
- **RGB receive "could not serialize message".** The raw rgb-lib-wasm receive
  result carried `BigInt`/wasm-bound values that break chrome structured-clone.
  `receiveRgb` now returns a plain object with `invoice`/`recipient_id` and
  `Number`-coerced `expirationTimestamp`/`batchTransferIdx` (witness + blinded).

## [1.0.0-beta.16] - 2026-06-26

### Fixed
- **`RgbLibWasmAdapter` RGB receive** — the blinded/witness receive built an
  invalid `Assignment` ("invalid type expected enum Assignment"): it passed a
  `BigInt` (rgb-lib-wasm wants a plain number) and `null` for no-amount (the enum
  needs the unit string `"Any"`). Receive now sends `{ Fungible: <number> }` or
  `"Any"`, and honors the `witness` flag (`witnessReceive` vs `blindReceive`) +
  the host-supplied `{ type, value }` assignment from `createRgbInvoice`.

## [1.0.0-beta.15] - 2026-06-26

### Added
- **Lean `./adapters/wdk/wasm-rgb` subpath export.** Exposes only
  `RgbLibWasmAdapter` + `registerWdkModule`/`hasWdkModule`, with no static
  reference to the other WDK adapters or `createWdkRegistry`. The full
  `./adapters/wdk` barrel statically re-exports every adapter, transitively
  pulling heavy/native deps (`lwk_wasm`, `sodium-native`,
  `@utexo/wdk-wallet-rgb`, `@arkade-os/wdk`) that a browser / MV3 service-worker
  host can't resolve. Importing from this lean entry lets such a host bundle
  just the wasm RGB-L1 backing (+ the injected `@utexo/rgb-lib-wasm`).

## [1.0.0-beta.14] - 2026-06-25

### Added
- **`RgbLibWasmAdapter` — node-less RGB-L1 via `@utexo/rgb-lib-wasm`.** A
  browser/WASM backing for the `RGB_L1` protocol, sibling to the native
  `RgbLibWdkAdapter`. Wraps the wasm-bindgen (web-target) `WasmWallet`
  (IndexedDB-persisted) onto the same `IProtocolAdapter` contract, reusing
  `RgbCore` so asset/balance shape cannot drift from the native/RLN backings.
  Unlike the native `@utexo/wdk-wallet-rgb` (filesystem `dataDir` + Node/Bare
  runtime), this loads in a browser / MV3 service worker — using only
  fetch/crypto/WebAssembly + IndexedDB — making self-custodial RGB-L1 possible
  without an rgb-lightning-node. Runtime-agnostic: the host injects an
  already-wasm-initialized module via
  `registerWdkModule('@utexo/rgb-lib-wasm', …)`; the adapter never touches
  fetch/URLs. Implements the begin→`signPsbt`→end flow for
  `sendAsset`/`sendBtcOnchain`/`createRgbUtxos`, `blindReceive` for RGB
  invoices; Lightning operations report `NOT_SUPPORTED`.
- `createWdkRegistry` gains `rgbL1Backing: 'native' | 'wasm'` (default
  `'native'`, preserving existing behavior) to choose the RGB_L1 backing.

## [1.0.0-beta.13] - 2026-06-23

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
- **Multi-rail unified send routing** — `CrossProtocolRouter.resolveUnifiedSend(uri,
  { preference })` parses a BIP21/BIP321 URI carrying several rails at once
  (BOLT12 offer, BOLT11, Spark/Arkade/Liquid addresses, RGB invoice, on-chain),
  matches each to the connected protocols that can settle it, and ranks them by a
  user `RoutePreference` (per-asset layer ranking) falling back to a Lightning-first
  default (`DEFAULT_RAIL_ORDER`). `.best` is the lite-mode auto-route; advanced mode
  gets the full ranked list. A plain (non-`bitcoin:`) string falls back to
  single-rail `resolveSend`. BOLT12 offers (`lno1…`) are now classified. BIP353
  (₿user@domain) is deferred — resolve it to a BIP321 URI in the host first.
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
- **Renamed the node-backed `RGB` protocol to `RGB_LN`** — the RGB rail is now
  always qualified: `RGB_LN` (RGB over an rgb-lightning-node, with Lightning +
  swaps) and `RGB_L1` (on-chain RGB via rgb-lib). There is no bare `RGB`
  `ProtocolType` anymore. Both the native `RgbAdapter` and the WDK `RlnWdkAdapter`
  now report `protocolName: 'RGB_LN'`; capability/operations manifest keys, the
  destination classifier candidates, and `createWdkRegistry` were updated to match.
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
