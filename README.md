# @kaleidorg/wallet-engine

> Multi-protocol Bitcoin L2 wallet engine — **native or WDK-backed** adapters for
> **Spark · RGB-LN · RGB-L1 · Liquid · Arkade** behind one `IProtocolAdapter` contract,
> with a cross-protocol router, BIP321 unified receive, and lite/advanced disclosure.

`wallet-engine` is the headless core you build a multi-protocol Bitcoin wallet on.
It hides the differences between Bitcoin L2s behind one interface, keeps the app code
the same across React Native, browser extension, and Node hosts, and ships the hard
parts — routing, unified receive, swaps, lite/advanced UX — as reusable primitives.
It powers KaleidoSwap's apps (`rate` mobile wallet, the browser extension, the desktop
agent).

```
┌──────────────────────────────────────────────────────────────┐
│  your app   (rate · extension · desktop)                      │
├──────────────────────────────────────────────────────────────┤
│  @kaleidorg/wallet-engine                                     │
│    ProtocolManager · CrossProtocolRouter · UnifiedReceive     │
│    Capability manifest · Disclosure (lite/advanced) · Swap    │
│    IProtocolAdapter contract  ·  Platform ports (injected)    │
├───────────┬───────────┬───────────┬───────────┬──────────────┤
│  Spark    │  RGB/RLN  │  Liquid   │  Arkade   │  (your proto) │
│  adapter  │  adapter  │  adapter  │  adapter  │   adapter     │
├───────────┴───────────┴───────────┴───────────┴──────────────┤
│  WDK modules · native SDKs · kaleido-sdk (RFQ/RLN client)     │
└──────────────────────────────────────────────────────────────┘
```

---

## Why

Every Bitcoin L2 (Spark, RGB-on-Lightning, Liquid, Arkade) ships its own SDK, its
own address formats, its own quirks (channel liquidity, boarding, invoice expiry,
zero-fee transfers). A wallet that wants to support more than one of them ends up
with `if (protocol === …)` smeared across every screen.

`wallet-engine` collapses that into **one contract + a data manifest of differences**:

- Screens call **one** API (`ProtocolManager` / `CrossProtocolRouter`), never a
  protocol SDK directly.
- Protocol *differences* live as **data** in a capability manifest, not as branches
  in app code — adding or changing a protocol never edits another protocol's path.
- The **same engine runs on every host**; platform specifics are injected.

---

## What you get

The adapters are the part you could write yourself. These four are the part you'd
rather not write twice:

| | | |
|---|---|---|
| **`CrossProtocolRouter`** | Hand it `lnbc1…`, a BIP321 URI, or a receive layer — get back the ranked protocols that can settle it, filtered to what's registered and connected. `.best` is the auto-route. | [`src/router`](src/router/index.ts) |
| **Unified receive** | **One** `bitcoin:` QR carrying on-chain + BOLT11/BOLT12 + Spark + Arkade + Liquid + RGB. Foreign wallets ignore the params they don't know. | [`src/receive`](src/receive/unifiedReceive.ts) |
| **Capability manifest** | Every protocol's layers, quirks and limits as *data*. The router and your UI read it; nothing special-cases a protocol by name. | [`src/capabilities`](src/capabilities/index.ts) |
| **Disclosure** | Lite vs advanced as one reversible setting rather than two codebases — lite collapses every BTC representation into "BTC". | [`src/disclosure`](src/disclosure/index.ts) |

Add a protocol and all four pick it up with zero changes to existing protocol code.

---

> [!WARNING]
> **Alpha — experimental, not production-ready.** This engine moves real funds across
> Bitcoin L2s. APIs may change without notice, and it has not been independently
> audited. Do not use it with mainnet funds you cannot afford to lose. Use at your own
> risk.

## Supported protocols

`Maturity` is the `maturity` field each protocol carries in the capability manifest —
read it at runtime, don't hardcode it.

| Protocol | Maturity | Layers | Assets | Swaps | Notable quirks | Backing module |
|---|:---:|---|---|:---:|---|---|
| **BTC**    | `stable` | on-chain | — | — | base on-chain only | (native) |
| **SPARK**  | `beta` | Spark, LN, on-chain | Spark tokens | — | zero-fee, static receive addr | `@tetherto/wdk-wallet-spark` |
| **RGB-LN** | `beta` | RGB-L1, RGB-LN, BTC-L1, BTC-LN | RGB (USDT, XAUT) | ✅ | needs channel liquidity (LSPS1) | `@kaleidorg/wdk-wallet-rln` |
| **RGB-L1** | `beta` | RGB-L1, BTC-L1 | RGB (USDT, XAUT) | — | on-chain only (no LN/channels), local rgb-lib | `@utexo/wdk-wallet-rgb` |
| **LIQUID** | `beta` | Liquid, Liquid assets | USDt (lite "USD") | — | own L1, no LN | `@kaleidorg/wdk-wallet-liquid` |
| **ARKADE** | `beta` | Arkade, LN | Arkade assets | — | boarding addr, static receive | `@arkade-os/wdk` |

Each protocol is described once in [`src/capabilities/index.ts`](src/capabilities/index.ts).
The router and UI read that manifest — they never special-case a protocol by name.

---

## Install

```bash
pnpm add @kaleidorg/wallet-engine
```

> Published as [`@kaleidorg/wallet-engine`](https://www.npmjs.com/package/@kaleidorg/wallet-engine)
> (renamed from the earlier `@kaleidorg/wallet-protocols`; versions ≤ 1.0.0-beta.11 were
> published under the old name).

The only hard dependencies are `@noble/*` and `@scure/*` (the pure-core crypto
primitives). Every protocol SDK is an **optional `peerDependency`** — install only the
ones whose adapters you use. Importing the root barrel pulls in **no** protocol SDK, and
each adapter lazy-loads its SDK inside `connect()`, so a missing peer only errors when you
actually load that adapter's subpath.

| You import… | Also install |
|---|---|
| `@kaleidorg/wallet-engine/adapters/wdk` (Spark) | `@tetherto/wdk-wallet-spark` |
| `…/adapters/wdk` (RGB/RLN) | `@kaleidorg/wdk-wallet-rln` |
| `…/adapters/wdk/wasm-liquid` | `@kaleidorg/wdk-wallet-liquid` |
| `…/adapters/wdk/wasm-rgb` | `@utexo/rgb-lib-wasm` |
| `…/adapters/wdk` (Arkade) | `@arkade-os/wdk` |
| `…/swap` | `@kaleidorg/wdk-protocol-swap-kaleidoswap` |
| `…/format` | `kaleido-sdk` |
| legacy `…/adapters/spark` \| `/arkade` \| `/rgb` \| `/flashnet` | `@buildonspark/spark-sdk` \| `@arkade-os/sdk` (+`@arkade-os/boltz-swap`) \| `kaleido-sdk` \| `@flashnet/sdk` |

```bash
# RGB/RLN + Liquid only, for example
pnpm add @kaleidorg/wallet-engine @kaleidorg/wdk-wallet-rln @kaleidorg/wdk-wallet-liquid
```

> **Migration (≤ beta.53 → beta.54):** protocol SDKs moved from `dependencies`/
> `optionalDependencies` to optional `peerDependencies`. They are no longer installed
> transitively — add the packages for the adapters you use (table above) to your own
> `package.json`.

---

## Quickstart

```ts
import {
  ProtocolManager,
  CrossProtocolRouter,
  buildUnifiedReceiveURI,
  aggregateForLite,
} from '@kaleidorg/wallet-engine'
// Adapters + registry live behind the SDK-bearing subpath, so the root stays SDK-free:
import { createWdkRegistry } from '@kaleidorg/wallet-engine/adapters/wdk'

// 1. Build a registry of WDK-backed adapters (pick the protocols you want).
const registry = createWdkRegistry({ enabled: ['RGB_LN', 'LIQUID', 'SPARK'] })

// 2. Connect each protocol (config carries the mnemonic + endpoints).
await registry.get('RGB_LN')!.connect({ protocol: 'RGB_LN', network: 'mainnet', /* … */ })
await registry.get('LIQUID')!.connect({ protocol: 'LIQUID', network: 'mainnet', /* … */ })

// 3. Drive everything through the manager — no protocol SDK in app code.
const manager = new ProtocolManager({ defaultProtocol: 'RGB_LN' })
for (const a of registry.getAll()) manager.registerAdapter(a)

const assets = await manager.listAllAssets()           // unified across protocols
const lite   = aggregateForLite(assets)                // { btc, usd, other }

// 4. Let the router choose which protocol pays a destination.
const router = new CrossProtocolRouter(registry)
const { best, routes } = router.resolveSend('lnbc1…')  // best = auto-route for lite mode

// 5. One QR that any wallet can pay; Kaleido wallets read the richer params.
const uri = buildUnifiedReceiveURI({
  btcAddress: 'bc1q…',
  lightningInvoice: 'lnbc1…',
  rgbInvoice: 'rgb:…',
  liquidAddress: 'lq1…',
})
```

---

## Run it first

The quickstart above needs a wallet behind it. This doesn't — it's the same
router, manifest and unified receive against four in-memory stub adapters, so you
can see the shape before you wire a single SDK:

```bash
git clone https://github.com/kaleidoswap/wallet-engine && cd wallet-engine
npm install
npm run example:tour
```

No node, no credentials, no network. See [`examples/tour`](examples/tour) for what
each section demonstrates, and [`examples/minimal-adapter`](examples/minimal-adapter)
for the whole contract in ~170 dependency-free lines.

---

## Core concepts

### `IProtocolAdapter` — the contract
Every protocol implements the same interface: connect, list assets/transactions,
create/decode invoices, send/receive, and (optionally) `getSwapQuote` / `executeSwap`.
See [`src/adapters/IProtocolAdapter.ts`](src/adapters/IProtocolAdapter.ts). Two flavours
ship: **native** adapters (direct SDK integrations) and **WDK-backed** adapters — both
satisfy the same contract, so the app can't tell which is underneath.

The contract is decomposed into a small required core (`ICoreProtocolAdapter`) plus
optional capability groups (`IRgbOperations`, `ISparkOperations`, `IArkadeOperations`,
`IBackupOperations`, `ISigningOperations`, `ISwapOperations`, …). `IProtocolAdapter` is
their composition (`Core & Partial<each group>`), so the flat surface is unchanged. A new
adapter can `implements ICoreProtocolAdapter & IRgbOperations` to opt into a group with
required (not optional) methods, and callers can reach a group cleanly with the narrowing
helpers — `asRgbOperations(adapter)`, `asSwapOperations(adapter)`, etc. Third-party
protocols implement the core and connect with any `BaseProtocolConfig`-shaped config.

### Capability manifest — differences as data
[`src/capabilities/index.ts`](src/capabilities/index.ts) is the single source of truth
for what each protocol can do (layers, swaps, channel liquidity, zero-fee, static
addresses, boarding…). **Rule:** when tempted to add a method to the contract for one
protocol, add a capability flag here instead.

### `ProtocolManager` — unified operations
[`src/manager/ProtocolManager.ts`](src/manager/ProtocolManager.ts) routes calls to the
active adapter and provides cross-protocol aggregates (`listAllAssets`,
`listAllTransactions`, `getPortfolioSummary`).

### `CrossProtocolRouter` — chooses *between* protocols
[`src/router/index.ts`](src/router/index.ts) takes a destination string or a receive
layer and returns the protocol(s) that can fulfil it, filtered to what's registered and
connected. `resolveSend().best` is the auto-route that makes **lite mode** possible.

For a unified payment URI that carries several rails at once (BIP21/BIP321 with a
BOLT12 offer + BOLT11 + Spark/Arkade/Liquid/RGB/on-chain), `resolveUnifiedSend(uri,
{ preference })` matches every rail to the protocols that can settle it and ranks them
by the user's `RoutePreference` (a per-asset layer ranking) — falling back to a
**Lightning-first** default. `.best` is the lite-mode pick; advanced mode shows the
full ranked list. (BIP353 `₿user@domain` is resolved to a URI by the host first.)

### Unified receive (BIP321)
[`src/receive/unifiedReceive.ts`](src/receive/unifiedReceive.ts) builds **one** `bitcoin:`
URI carrying on-chain + Lightning (BOLT11/BOLT12) + Spark + Arkade + Liquid + RGB. Other
wallets ignore the unknown params; Kaleido-aware wallets get the full menu. The address is
optional, so a lite wallet can publish a single LN/asset-only QR.

### Disclosure (lite / advanced)
[`src/disclosure/index.ts`](src/disclosure/index.ts) — lite vs advanced is **one
reversible setting**, not a code fork. It controls how much the UI reveals (networks,
route selector, channel management, raw ids) and how much the router auto-decides. Lite
mode collapses every BTC representation into one "BTC" and USDt-on-Liquid into one "USD".

### Platform ports — write once, run everywhere
[`src/ports/index.ts`](src/ports/index.ts) — the engine never touches platform APIs.
Each host injects `IStorageProvider` + `IRuntimeProvider` (storage, CSPRNG, clock) so
the same engine runs on React Native (SecureStore/MMKV), the extension (chrome.storage),
and Node unchanged.

---

## Swaps

[`KaleidoswapSwap`](src/swap/KaleidoswapSwap.ts) wraps the Kaleidoswap **RFQ** flow
(quote → execute → status) behind domain `Quote` / `SwapResult` types — no SDK types
leak across the boundary.

```ts
import { KaleidoswapSwap } from '@kaleidorg/wallet-engine'

const swap = new KaleidoswapSwap(rlnAccount, {
  baseUrl: 'https://api.kaleidoswap.com',
  // Optional: defaults to 100 bps (1%); use 0 for exact from-leg matching.
  maxQuoteSlippageBps: 100,
})

const quote = await swap.getQuote({
  fromAsset: 'rgb:USDT…', toAsset: 'BTC',
  fromLayer: 'RGB_LN',    toLayer: 'BTC_LN',
  fromAmount: 100,
})

const result = await swap.executeSwap({
  ...quote, receiverAddress: 'lnbc1…', receiverAddressFormat: 'BOLT11',
})

const status = await swap.getSwapStatus(result.swapId) // pending → confirmed/failed
```

---

## Extending: add a protocol

1. Implement `IProtocolAdapter` (native or WDK-backed).
2. Add one entry to the capability manifest describing its layers + quirks.
3. Register it: `manager.registerAdapter(new MyAdapter())`.

The router, unified receive, lite aggregation, and every screen pick it up with **zero
changes** to existing protocol code. New protocol-specific behaviour is a capability
flag, never a new method on the contract.

---

## Public API

The root barrel, [`src/index.ts`](src/index.ts), is deliberately **SDK-free**: types, the
`IProtocolAdapter` contract + registry, capability manifest, platform ports,
`CrossProtocolRouter` + destination classifier, unified receive, the disclosure model,
`ProtocolManager`, and the Arkade VTXO-lifecycle helpers. Adapters, `createWdkRegistry`,
`KaleidoswapSwap`, and the client managers live behind their own subpath exports (see
[`package.json`](package.json) `exports`) so importing the root pulls in no protocol SDK.

---

## Where it sits

```
wallet-engine    wallet engine    (this package)
   └─ depends on
kaleido-sdk      protocol client (RFQ/maker + RLN), Python + TypeScript
```

`wallet-engine` consumes `kaleido-sdk` internally for the Kaleidoswap protocol;
consumers of `wallet-engine` never import `kaleido-sdk` directly.

---

## Status

**Alpha — experimental.** Published under a `1.0.0-beta` version tag, but treat the
project as alpha: interfaces are unstable and nothing has been audited. Per-protocol
readiness is not prose — it's the `maturity` field in the capability manifest, shown in
[Supported protocols](#supported-protocols) and readable at runtime:

```ts
import { PROTOCOL_CAPABILITIES } from '@kaleidorg/wallet-engine'
PROTOCOL_CAPABILITIES.RGB_LN.maturity   // 'beta'
```

Native fallback adapters remain available alongside the WDK-backed ones.

## License

[MIT](LICENSE)


## Bark on React Native (initial backend)

The opt-in `@kaleidorg/wallet-engine/backends/bark-react-native` entry point wraps
Second's on-device Bark wallet. It currently supports opening or explicitly
creating a wallet, recovery status, categorized balances, movement history, Ark
receiving addresses, manual sync, Ark payments, and shutdown. It is a backend
foundation, **not yet an `IProtocolAdapter`**: it is not registered with
`ProtocolManager` or the cross-protocol router. Arkade remains a separate backend.

Install `@secondts/bark-react-native@0.25.0` in the **host app**. For Expo, add
`@secondts/bark-react-native` to `expo.plugins` and rebuild the native app. The
published package requires React Native 0.75+ (Expo SDK 52+), New Architecture,
and Hermes; Expo Go does not support it. See [Second's React Native guide](https://second.tech/docs/bark-sdk/react-native)
and the [published SDK](https://www.npmjs.com/package/@secondts/bark-react-native/v/0.25.0).
The implementation targets the published `Wallet.open` API; older quickstart
examples using `Wallet.create` do not match this pinned version.

```ts
import { BarkReactNativeBackend } from '@kaleidorg/wallet-engine/backends/bark-react-native'

const bark = new BarkReactNativeBackend()
await bark.connect({
  network: 'signet',
  serverUrl: 'https://ark.signet.2nd.dev',
  esploraUrl: 'https://esplora.signet.2nd.dev',
  dataDir,  // existing app-private absolute path, supplied by the host
  mnemonic, // read from the host's secure storage; never log it
  createIfMissing: true, // use only when explicitly initializing/restoring locally
})

const info = await bark.getWalletInfo() // includes recovery completeness
await bark.sync()
const address = await bark.getReceiveAddress()
const balance = await bark.getBalance()
// Show balance.spendableSats as spendable; keep pending categories separate.

// Call only after the host has authorized this destination and amount:
// await bark.sendArkPayment({ address: recipientArkAddress, amountSats: 1000 })

await bark.disconnect()
```

The host creates and protects the directory, stores the mnemonic securely, and
backs up the wallet database. Do not open the same directory from another JS
runtime, another native handle, or a symlink alias. Opening defaults to an existing
wallet; errors never trigger a create/recovery fallback. A recovery result of
`incomplete` or `failed` means the displayed balance may omit funds. Native code
loads only on `connect()`, and never through the engine root barrel.

No daemon starts automatically. The host explicitly calls `sync()` to process
incoming payments and progress pending Bark operations. Balance/history reads do
not sync, fund, board, refresh VTXOs, or broadcast payments. Disconnect waits for
queued operations and native shutdown; if shutdown fails, retry disconnect before
reopening. The backend does not retain the supplied mnemonic after opening;
the native SDK owns the wallet keys for its lifetime.

`sendArkPayment` validates integer satoshis and asks the native SDK whether the
address is deliverable on the selected network/server. Success returns
`{ status: 'submitted', address, amountSats }`: Bark's arkoor call does not return a
transaction id, payment hash, fee, or recipient receipt. A supplied `maxFeeSats`
is rejected because this SDK method cannot enforce it. A native send error is
`PAYMENT_OUTCOME_UNKNOWN`; inspect `getHistory()` before deciding whether to retry.
History exposes signed balance deltas and fees separately, not invented payment
amounts. SDK exception details are withheld because they may contain secrets.

Next steps are a Bark protocol adapter and routing identity, Lightning with fee
and settlement handling, boarding/offboarding, VTXO refresh and exit/recovery
controls, and device tests. These operations are not advertised by this backend.
Unit tests use a mock native wallet; Android/iOS native loading and live signet
payments still require validation in a development build.

When upgrading the optional SDK, compile its structural contract fixture with
that peer installed (no native code executes):

```sh
npx tsc --noEmit --strict --skipLibCheck --target ES2020 --module ES2020 \
  --moduleResolution bundler test/bark-native.types.ts
```
