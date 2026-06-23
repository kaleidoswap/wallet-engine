# @kaleidorg/wallet-engine

> Multi-protocol Bitcoin L2 wallet engine — **native or WDK-backed** adapters for
> **Spark · RGB/RLN · Liquid · Arkade** behind one `IProtocolAdapter` contract,
> with a cross-protocol router, BIP321 unified receive, and lite/advanced disclosure.

> [!WARNING]
> **Alpha — experimental, not production-ready.** This engine moves real funds across
> Bitcoin L2s. APIs may change without notice, adapters are incomplete, and it has not
> been independently audited. Do not use it with mainnet funds you cannot afford to lose.
> Use at your own risk.

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

## Supported protocols

| Protocol | Layers | Assets | Swaps | Notable quirks | Backing module |
|---|---|---|:---:|---|---|
| **BTC**    | on-chain | — | — | base on-chain only | (native) |
| **SPARK**  | Spark, LN, on-chain | Spark tokens | — | zero-fee, static receive addr | `@tetherto/wdk-wallet-spark` |
| **RGB/RLN**| RGB-L1, RGB-LN, BTC-L1, BTC-LN | RGB (USDT, XAUT) | ✅ | needs channel liquidity (LSPS1) | `@kaleidorg/wdk-wallet-rln` |
| **LIQUID** | Liquid, Liquid assets | USDt (lite "USD") | — | own L1, no LN | `@kaleidorg/wdk-wallet-liquid` |
| **ARKADE** | Arkade, LN | Arkade assets | — | boarding addr, static receive | `@arkade-os/wdk` |

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

Heavy protocol SDKs are **optional dependencies** — install only the adapters you use:

```bash
# RGB/RLN + Liquid only, for example
pnpm add @kaleidorg/wdk-wallet-rln @kaleidorg/wdk-wallet-liquid
```

The engine lazy-loads each WDK module inside its adapter's `connect()`, so importing
`wallet-engine` does **not** pull every protocol SDK into your bundle.

---

## Quickstart

```ts
import {
  ProtocolManager,
  CrossProtocolRouter,
  createWdkRegistry,
  buildUnifiedReceiveURI,
  aggregateForLite,
} from '@kaleidorg/wallet-engine'

// 1. Build a registry of WDK-backed adapters (pick the protocols you want).
const registry = createWdkRegistry({ enabled: ['RGB', 'LIQUID', 'SPARK'] })

// 2. Connect each protocol (config carries the mnemonic + endpoints).
await registry.get('RGB')!.connect({ protocol: 'RGB', network: 'mainnet', /* … */ })
await registry.get('LIQUID')!.connect({ protocol: 'LIQUID', network: 'mainnet', /* … */ })

// 3. Drive everything through the manager — no protocol SDK in app code.
const manager = new ProtocolManager({ defaultProtocol: 'RGB' })
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

## Core concepts

### `IProtocolAdapter` — the contract
Every protocol implements the same interface: connect, list assets/transactions,
create/decode invoices, send/receive, and (optionally) `getSwapQuote` / `executeSwap`.
See [`src/adapters/IProtocolAdapter.ts`](src/adapters/IProtocolAdapter.ts). Two flavours
ship: **native** adapters (direct SDK integrations) and **WDK-backed** adapters — both
satisfy the same contract, so the app can't tell which is underneath.

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

const swap = new KaleidoswapSwap(rlnAccount, { baseUrl: 'https://api.kaleidoswap.com' })

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

The package's surface is its barrel, [`src/index.ts`](src/index.ts): types, the
`IProtocolAdapter` contract + registry, capability manifest, platform ports, all native
and WDK adapters, `createWdkRegistry`, `CrossProtocolRouter` + destination classifier,
`KaleidoswapSwap`, unified receive, the disclosure model, `ProtocolManager`, and the
per-protocol client managers.

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
project as alpha: interfaces are unstable, several adapters are partial, and nothing has
been audited. WDK adapters are `beta` maturity (native fallbacks remain available); see
the `maturity` field per protocol in the capability manifest.

## License

[MIT](LICENSE)
