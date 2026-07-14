# Changelog

All notable changes to `@kaleidorg/wallet-engine` are documented here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/) (currently in a
`1.0.0-beta` pre-release line).

## [Unreleased]

## [1.0.0-beta.56] - 2026-07-14

Security track: hardens the highest-severity input surface and adds a
first-class, opt-in policy layer for fund-moving/signing operations.

### Added
- **Signing/spend policy engine** (`src/policy`): `evaluatePolicy`/`enforcePolicy`,
  pure and I/O-free. Enforces per-transaction spend limits (global + per-grant),
  destination allowlists (exact match or by classified destination kind), and
  per-app capability grants. Default-allow (a policy only ever tightens);
  `mode: 'deny'` requires an explicit matching grant. Wired into
  `ProtocolManager` as opt-in (`config.policy` + `setActiveGrant()`) — gates
  `sendPayment`/`payKeysend`/`executeSwap`/`signMessage` and throws
  `PolicyError` on denial. No policy configured ⇒ unchanged behavior.
  Exported from the root barrel.

### Testing
- Property-based fuzzing (`fast-check`) of `classifyDestination` — the
  destination classifier is the highest-severity input surface, since a wrong
  classification misroutes funds to the wrong chain. Verifies it never throws,
  is deterministic, and never cross-classifies a valid Spark/Arkade/Liquid
  address as a different protocol. Regression guards lock the documented
  fund-misrouting hazards (`sp1…` Silent Payments vs Spark, `lntbs1…` signet
  BOLT11, `lq1…` Liquid vs BTC on-chain).

## [1.0.0-beta.55] - 2026-07-13

Upstreams fixes/features that were previously carried as a patch in the
browser extension, so every consumer gets them.

### Fixed
- **RGB-L1 (wasm) wallet creation crashed on mainnet.** rgb-lib rejects the IFA
  (inflatable) schema on mainnet (`CannotUseIfaOnMainnet`), so declaring it made
  `WasmWallet.create` throw before the wallet could open. IFA is now gated to the
  test networks; mainnet is NIA-only until rgb-lib whitelists IFA.
- **Outbound RGB-LN payment status never resolved.** `getPaymentStatus` queried
  the node's invoice-status endpoint, which only knows INBOUND invoices — so a
  withdraw poll timed out even after the payment settled. It now reads the sent
  payment from `list_payments` (keyed by `payment_hash`) and never throws
  (unknown/failed lookup → `pending`).

### Added
- **Arkade HD-wallet mode** (`ArkadeConfig.walletMode: 'static' | 'hd'`). `'hd'`
  uses an HD-capable `MnemonicIdentity`, rotates receive addresses across
  `…/0/N`, runs a gap-limit `restore()` scan on connect, and uses a separate
  IndexedDB store. Requires a BIP-39 mnemonic (nsec/hex secrets stay single-key).
  Default remains `'static'` (backward-compatible, legacy store name).
- `RgbConfig.mnemonic?` — the WDK RLN adapter derives its signing seed on-device.

### Fixed (packaging)
- Corrected the `@utexo/rgb-lib-wasm` peer-dependency range (`^1.0.0-beta.3`;
  was mistakenly `^0.3.0` in beta.54).

## [1.0.0-beta.54] - 2026-07-13

First changelog entry since beta.31; covers the security, packaging, and
release-tooling work landed across beta.32–beta.54.

### Changed
- **BREAKING: protocol SDKs are now optional `peerDependencies`.** Only
  `@noble/*` and `@scure/*` remain hard dependencies. Every protocol SDK
  (`@buildonspark/spark-sdk`, `@arkade-os/*`, `@flashnet/sdk`,
  `@tetherto/wdk-wallet-spark`, `@kaleidorg/wdk-wallet-rln`,
  `@kaleidorg/wdk-wallet-liquid`, `@kaleidorg/wdk-protocol-swap-kaleidoswap`,
  `@utexo/wdk-wallet-rgb`, `@utexo/rgb-lib-wasm`, `kaleido-sdk`) is an optional
  peer — install only the ones whose adapters you use. Importing the root barrel
  pulls in no protocol SDK; each adapter lazy-loads its SDK in `connect()`.
  **Migration:** add the SDKs for your adapters to your own `package.json` (see
  the adapter→package table in the README). Also declares the previously
  undeclared (phantom) `@utexo/rgb-lib-wasm`.

### Security
- **A locked wallet can no longer sign.** `BaseWdkAdapter.disconnect()` now
  clears the retained mnemonic, and `signPsbt`/`signMessage` assert the adapter
  is connected — previously, after `disconnectAll()` (the lock path) a held
  adapter could still sign PSBTs/messages with the root key.
- **Fail-loud secret resolution.** A bad-checksum `nsec` or invalid BIP-39 phrase
  in the Spark/Arkade client managers no longer silently derives a valid-but-
  different (empty) wallet — it throws.
- **RLN escape-hatch hardening.** `changePassword`/`restore` removed from the
  allowlist; node-side `signMessage` now honors the LNURL-auth phishing guard.
- **Destination classifier** no longer throws on malformed percent-encoding in a
  BIP21 `lightning=` parameter (a hostile QR classified, not a crash).
- Spark/Arkade `getConfig()` now redacts the mnemonic.

### Fixed
- **Swap execution is bound to the approved quote.** `executeSwap` enforces the
  approved quote's expiry before ordering and rejects a fill that degrades past a
  slippage bound (`maxSlippageBps`, default 1%) — the maker re-quotes internally
  and was never bound to the user-approved quote.

### Dependencies
- Pinned `kaleido-sdk` to `0.1.11` (0.1.12+ removed the swap-order API the legacy
  `RgbAdapter` uses).

### Tooling
- Live integration suite (Spark/Liquid/Arkade/RGB-L1 on test networks) with real
  Alice→Bob sends, triggered on adapter-touching PRs + manual dispatch.
- Release pipeline now gated on `npm test` + a bare-Node package-import check.

## [1.0.0-beta.31] - 2026-07-01

### Fixed
- **RGB-L1 BTC on-chain balance reads 0 after unlock.** On restore from a *thin*
  BDK snapshot (no revealed SPKs — the state left when an MV3 service-worker
  teardown interrupts rgb-lib-wasm's async IndexedDB save), an incremental `sync`
  can only re-query already-revealed SPKs and cannot rediscover on-chain BTC, so
  the balance shows 0 despite real funds. `connect()` now runs a one-time
  recovery: after an incremental sync, if BTC still reads 0 it runs `fullScan`
  (BIP44 stop-gap) to rebuild the UTXO set from the indexer, then `flush()` so the
  recovered state persists (normal incremental sync suffices thereafter). Both
  calls are version-guarded (no-op on `@utexo/rgb-lib-wasm ≤ beta.2`, which lacks
  `fullScan`/`flush`) and best-effort so a scan failure never blocks connect.
  Requires `@utexo/rgb-lib-wasm ≥ 1.0.0-beta.3`.

## [1.0.0-beta.30] - 2026-07-01

### Added
- **RGB wallet-state backup on the WASM (RGB-L1) adapter.** RGB is stateful —
  allocations/consignments can't be rebuilt from the seed — so state must be
  backed up after every settled transfer. Surfaced the rgb-lib backup/VSS
  primitives on `RgbLibWasmAdapter` (and as optional `IProtocolAdapter` hooks):
  - Local encrypted file: `backup(password)` (existing), `restoreBackup({ backupBytes, password })`,
    `backupInfo()` (→ `{ required }`, "changed since last backup").
  - Cloud (VSS): `configureVssBackup({ serverUrl, storeId, signingKeyHex })`,
    `disableVssBackup()`, `vssBackup()` (→ `{ serverVersion }`),
    `vssBackupInfo()` (→ `{ backupExists, serverVersion, backupRequired }`),
    `vssRestoreBackup()`. rgb-lib encrypts client-side, so the VSS server only
    stores ciphertext; the store is versioned (optimistic concurrency).
  All calls route through the serialized account queue (rgb-lib-wasm is
  single-threaded) and normalize BigInt → number so results survive the
  extension's service-worker structured-clone boundary.

## [1.0.0-beta.29] - 2026-06-30

### Fixed
- **RGB-L1 sends failing with "Insufficient total assignments" despite a
  non-zero balance.** The WASM adapter now runs a `sync` + `refresh` immediately
  before `sendBegin` (and before `createUtxosBegin`). rgb-lib's `send` only
  spends *settled* allocations it knows about locally; after a service-worker
  restart or IndexedDB restore the received transfer had not been promoted to
  settled, so the spend saw zero spendable allocations even though the balance
  UI (which polls `refreshBalances`) showed funds.

### Added
- **Durable persistence via `flush()`.** Every state-mutating WASM operation
  (`refresh`, `blindReceive`/`witnessReceive`, `createUtxos`, `sendAsset`,
  `sendBtcOnchain`, transfer maintenance) now durably commits to IndexedDB
  before returning. Version-guarded: a no-op on `@utexo/rgb-lib-wasm@1.0.0-beta.2`
  (where `flush()` is absent), active once the bindings are bumped.
- **Missing `IProtocolAdapter` RGB hooks now implemented on the WASM adapter:**
  `listRgbUnspents()` (→ `listUnspents`), `estimateRgbFee(blocks)`
  (→ `getFeeEstimation`), and `getRgbDetailedBalance()` (vanilla/colored split).
- **Transfer maintenance + metadata helpers:** `getInvoiceStatus({ invoice })`,
  `getAssetMetadata(assetId)`, `failRgbTransfers()` and `deleteRgbTransfers()`
  to clear stuck pending transfers that hold allocations.

## [1.0.0-beta.28] - 2026-06-30

### Fixed
- **RGB-L1 withdraw routing and BTC balance parity with rgb-lib clients.** The
  WASM adapter now sends RGB recipient maps using the same snake_case fields as
  the desktop rgb-lib flow while keeping the wasm camelCase aliases, uses plain
  numeric `{ Fungible: amount }` assignments for sends, and exposes the
  spendable BTC total across both vanilla and colored on-chain buckets so
  RGB-L1 wallets do not show a misleading zero when funds are held in colored
  UTXOs.

## [1.0.0-beta.27] - 2026-06-30

### Fixed
- **RGB-L1 BTC balance, BTC history, and RGB sends.** The WASM adapter now reads
  flat BTC balance aliases (`confirmed`/`available`/`unconfirmed`) in addition
  to the `vanilla` split, normalizes BTC transaction amount aliases and signed
  amounts for history, and builds rgb-lib recipient maps with the required
  `assignment` field for RGB asset withdrawals.

## [1.0.0-beta.26] - 2026-06-30

### Fixed
- **RGB-L1 balances and activity after unlock.** `rgbAssetBalance` now accepts
  the raw rgb-lib/WASM balance aliases (`total`/`available`/`pending`) and
  BigInt/string values, while preserving the detailed RGB fields
  (`settled`/`future`/`spendable`) that the extension uses for expanded balance
  views. The WASM adapter also normalizes asset records whose balance fields are
  flattened onto the asset object, so RGB assets no longer collapse to 0 after a
  detail balance refresh.

## [1.0.0-beta.22] - 2026-06-29

### Fixed
- **Destination classifier missed several real Spark address HRPs.** The Spark
  matcher only covered `spark`/`sparkrt`/`sprt`/`spt`, so testnet (`sparkt1`),
  local/signet (`sparkl1`), and the legacy `spl1` forms fell through to
  `UNKNOWN` — a misclassification that breaks Spark routing for those networks.
  The set is now `spark`/`sparkt`/`sparkrt`/`sparkl`/`spl`/`sprt`, matching the
  `@buildonspark/spark-sdk` address encoder. `sp1` remains excluded on purpose:
  it is the BIP352 Silent Payments HRP, and matching it as Spark would misroute
  funds. Added coverage for every HRP plus a Silent-Payments fail-closed test.

## [1.0.0-beta.21] - 2026-06-27

### Fixed
- **RgbCore: received RGB assets showed a 0 balance.** `rgbAssetBalance`/
  `rgbNiaAsset` collapsed the balance with `spendable ?? settled`, which returns
  0 when `spendable` is present-but-zero — exactly the case for a just-received
  asset (it has a real `settled`/`future` balance but isn't spendable yet). Now
  the owned total uses `future || settled || spendable` (skipping zeros),
  `available` = spendable, `pending` = incoming.

## [1.0.0-beta.20] - 2026-06-27

### Fixed
- **RgbLibWasmAdapter: serialize all wasm calls.** rgb-lib-wasm is
  single-threaded and not reentrant — when a second op started while an async one
  (refresh/sync/send/receive) was mid-flight (e.g. opening an asset detail that
  fires balance + transfers + transactions at once), its thread-locals corrupted
  and it panicked ("Lazy instance has previously been poisoned" → `RuntimeError:
  unreachable`), after which every call traps. The wallet handle is now wrapped in
  a queue so calls never overlap; all wallet methods are async and awaited.

## [1.0.0-beta.19] - 2026-06-26

### Fixed
- **RgbLibWasmAdapter: scope the IndexedDB store by rgb-lib network.** rgb-lib
  panics (`RuntimeError: unreachable`) when a wallet store created under one
  `BitcoinNetwork` is reopened under another — e.g. after the beta.18 Signet →
  SignetCustom change. The `dataDir` now derives from the rgb-lib network
  (`rgb-l1-signetcustom`, `rgb-l1-regtest`, …) instead of the host network
  label, so each network gets its own store and the same network stays
  persistent. Addresses are derivation-identical, so on-chain funds re-appear
  after a sync.

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
