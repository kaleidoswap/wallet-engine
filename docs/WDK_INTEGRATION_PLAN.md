# WDK Integration Plan — Unified Wallet Engine

**Status:** Draft v1 · **Owner:** wallet-protocols · **Date:** 2026-06-03

Goal: make `@kaleidorg/wallet-protocols` the single wallet engine for both `rate`
(React Native) and `rate-extension` (browser), with each protocol implemented as a
thin adapter over an **independently-versioned WDK module**, plus a `lite`/`advanced`
disclosure layer on top. Changing one protocol must touch only that protocol's package.

---

## 0. Locked decisions

- **Lite-mode "USD" = USDt on Liquid** (via `@kaleidorg/wdk-wallet-liquid` → `lwk`). Mature,
  cheap, deep liquidity. RGB USDT stays for advanced/swap flows only.
- **We own** `@kaleidorg/wdk-wallet-rln`, `@kaleidorg/wdk-wallet-liquid`, and
  `@kaleidorg/wdk-protocol-swap-kaleidoswap`.
- **Modes** = a reversible `disclosureLevel` setting (default chosen at wallet creation),
  NOT a code fork.

---

## 1. Current state (ground truth, 2026-06-03)

### Already built
| Asset | What it is | Notes |
|---|---|---|
| `@kaleidorg/wallet-protocols` (`feat/cross-l2-types`) | Shared engine: `IProtocolAdapter`, `ProtocolManager`, `ProtocolAdapterRegistry`, Spark/Arkade/Rgb adapters, types (`base`, `arkade`, `spark`, `rgb`, `flashnet`, `cross-l2`) | Adapters currently wrap **native** SDKs |
| `@tetherto/wdk` (`1.0.0-beta.5`) | WDK orchestrator | depends on `bare-node-runtime` |
| `@tetherto/wdk-wallet-spark` (`1.0.0-beta.17`) | Spark WDK module | wraps `@buildonspark/spark-sdk`; exports `{ default, bare, pear }` |
| `@kaleidorg/wdk-wallet-liquid` (`1.0.0-beta.1`) | **We own.** Liquid WDK module | wraps `lwk` (`lwk_node`/`lwk_wasm`); exports `{ default, bare }` |
| `@kaleidorg/wdk-wallet-rln` (`1.0.0-beta.2`) | **We own.** RGB-Lightning WDK module | wraps `kaleido-sdk`; exports `{ default, bare }`; `node_modules` installed |
| `@kaleidorg/wdk-protocol-swap-kaleidoswap` (`1.0.0-beta.2`) | **We own.** Maker/swap as a WDK protocol module | wraps `kaleido-sdk` |
| `rate` | RN app, consumes `@kaleidorg/wallet-protocols` + `kaleido-ui` via Redux view-model | |
| `rate-extension` | MV3 extension, own `src/protocols/` duplicate, Zustand | to converge on the shared engine |

### Apps converged independently
Both apps already use the same adapter/router/capability shape. `rate-extension` even has
`bip21.ts` multi-protocol receive builders + `BtcUnifiedReceive` (the unified-QR seed).

---

## 2. The runtime question (THE gate)

WDK modules target the **Bare (Holepunch) runtime** (`bare-node-runtime`,
`@buildonspark/bare`, `sodium-universal`). Every module also ships a `default`
(non-Bare) export condition. The integration hinges on which export survives in each host:

| Host | Strategy | Risk |
|---|---|---|
| Node (CI/spike) | `default` export | low — validate first |
| React Native (`rate`) | Bare-on-mobile via `bare-expo`/`pear-wrk` (Arkade WDK already does this) **or** `default` + RN polyfills | medium |
| Extension MV3 service worker | `default` export in SW; fallback = offscreen document; last resort = keep native SDK for extension | **high — gating spike** |

If MV3 fails: `rate` still moves to WDK; the extension keeps native adapters behind the
*same* `IProtocolAdapter`. The contract makes that a per-host choice, not a rewrite.

---

## 3. Target architecture

```
  @kaleidorg/wallet-protocols  ── the engine (integration hub)
  ├─ contract:   IProtocolAdapter + domain types        (stable seam, additive-only)
  ├─ capability: ProtocolCapabilities manifest            (differences = DATA, not methods)
  ├─ registry:   ProtocolAdapterRegistry / ProtocolManager (runtime registration, no static protocol imports)
  ├─ router:     cross-protocol route resolver            (picks BETWEEN protocols; sits on WDK in-module detection)
  ├─ ports:      IStorageProvider, IRuntimeProvider        (platform injected)
  └─ adapters:   thin WDK wrappers ↓ (map WDK module → IProtocolAdapter; NO WDK types cross the seam)
        SparkAdapter   → @tetherto/wdk-wallet-spark
        ArkadeAdapter  → @arkade-os/arkade-wdk      (external; has RN provider)
        LiquidAdapter  → @kaleidorg/wdk-wallet-liquid   (NEW — provides L-BTC + USDt "USD")
        RlnAdapter     → @kaleidorg/wdk-wallet-rln
        SwapModule     → @kaleidorg/wdk-protocol-swap-kaleidoswap

  rate (Redux view-model) ─┐
                           ├── consume the engine; register only enabled adapters
  rate-extension (Zustand) ┘

  WDK modules = independently versioned plugins (already are).
```

### Blast-radius guarantee
A protocol change happens in its `wdk-wallet-*` package → bump that package → bump its
thin adapter only if the wrapper signature changed. Other protocols don't rebuild/republish.
The shared **contract** is the only cross-cutting seam, so it is **additive-only and reviewed**.

### Three discipline rules (enforced in review/CI)
1. **Capabilities as data, not interface methods.** Protocol quirks (boarding, zero-fee,
   static address, Lightning support) live in the capability manifest, never widen the contract.
2. **Registry, never static imports.** The engine never `import`s a concrete adapter; apps register.
3. **No WDK/SDK types cross the contract.** Adapters translate to domain types — the shock
   absorber that keeps WDK swappable and allows per-protocol native fallback.

---

## 4. Phases

### Phase 0 — Runtime spikes & contract freeze (GATE) — ~1 wk
- [x] **Spike A — PASS (2026-06-03):** non-Bare `default` export loads in plain Node for all
      three tested modules. `spikes/spike-a-default-export.mjs`.
      - `@kaleidorg/wdk-wallet-rln` ✅ (`RlnAccount` + default manager)
      - `@kaleidorg/wdk-wallet-liquid` ✅ (`LiquidAccount` + default manager)
      - `@tetherto/wdk-wallet-spark` ✅ after `npm install` — import 207ms, constructed manager
        (`getAccount`/`getAccountByPath`/`getFeeRates`), **derived real address**
        `sparkrt1pgss...`. Account surface captured (see §3.1).
      - **Takeaway: WDK runs outside Bare in plain JS today → strong signal for RN/MV3 hosts.**
- [ ] **Spike B (gating):** load a WDK module inside `rate-extension`'s MV3 service worker.
- [ ] **Spike C:** load a WDK module on a physical iOS+Android `rate` build (Bare-on-mobile).
- [ ] Freeze the v1 `IProtocolAdapter` contract + `ProtocolCapabilities` shape.
- **Exit:** documented pass/fail per host; per-protocol "WDK vs native fallback" decision.

### Phase 1 — Engine scaffolding (additive, non-breaking) — ~1 wk
- [x] Add `src/capabilities/` manifest — `PROTOCOL_CAPABILITIES` (BTC/SPARK/ARKADE/RGB/LIQUID),
      differences-as-data backbone + `getCapabilities`/`protocolsForLayer`. (2026-06-03)
- [x] Add `src/adapters/wdk/SparkWdkAdapter.ts` skeleton — core receive/balance/invoice/send
      wired to real WDK calls; rest stubbed for Phase 2; no WDK types cross the contract. (2026-06-03)
- [x] Extend `types/base.ts` additively for Liquid (`LIQUID` protocol, `BTC_LIQUID`/`LIQUID_ASSET`
      layers, `LIQUID_ADDRESS` format). (2026-06-03)
- [x] **Exit gate met (proof):** `register → resolve → derive` runs end-to-end against the real
      `@tetherto/wdk-wallet-spark`, returns domain `Address` `sparkrt1pgss…`. (2026-06-03)
- [x] Add `src/ports/` — `IStorageProvider`, `IRuntimeProvider`, `PlatformContext`. (2026-06-03)
- [x] Wire WDK modules as `optionalDependencies` of `wallet-protocols` + tsconfig paths
      (`../wdk-wallet-spark`, `../wdk-wallet-rln`, `../wdk-wallet-liquid`,
      `../wdk-protocol-swap-kaleidoswap`). WDK Spark types now resolve in-package (revealed
      Spark supports `SIGNET` natively → mapped). (2026-06-03)
- [x] **Typecheck (rate tsc 5.9.3, `--noEmit`):** all new WDK/capabilities/ports/types files
      compile clean. (2026-06-03)
- [ ] ⚠️ **Pre-existing blocker (not WDK):** `src/adapters/RgbAdapter.ts:563` — `skip_sync` not
      in current `kaleido-sdk` `createutxos` type (SDK type drift). Blocks `npm run build` emit.
      One-line cast fixes it; left untouched (RGB scope / branch WIP).

#### §3.1 — Captured WDK Spark account surface (Spike A)
`manager`: `getAccount`, `getAccountByPath`, `getFeeRates`.
`account`: `getAddress`, `getBalance`, `sendTransaction`, `transfer`, `getStaticDepositAddress`,
`getSingleUseDepositAddress`, `quoteWithdraw`, `withdraw`, `createLightningInvoice`,
`payLightningInvoice`, `createSparkSatsInvoice`, `createSparkTokensInvoice`, `paySparkInvoice`,
`syncWalletBalance`, `toReadOnlyAccount`, `dispose`, `cleanupConnections`.

### Phase 2 — Spark vertical end-to-end in `rate` — ~2 wk
- [ ] Complete `SparkWdkAdapter` (balance / receive / send / invoice).
- [ ] Swap `rate`'s Spark path from native → WDK adapter behind the existing Redux view-model.
- **Exit:** a real Spark send+receive in `rate` runs entirely through the WDK adapter. Pattern proven.

### Phase 3 — Fan out (parallel tracks) — ~3–5 wk
- [ ] `RlnAdapter` → `@kaleidorg/wdk-wallet-rln` (move RGB wrapping down a layer).
- [ ] `LiquidAdapter` → `@kaleidorg/wdk-wallet-liquid` (**NEW**; map "USD" → Liquid USDt asset).
- [ ] `ArkadeAdapter` → `@arkade-os/arkade-wdk`.
- [ ] Native SDK stays as per-protocol fallback where the WDK module is too beta.
- **Exit:** all protocols register + pass send/receive/balance in `rate`. Blast-radius test passes.

### Phase 4 — Cross-protocol router + swap module — ~2 wk
- [ ] Move `account-routing` / `route-resolver` logic into engine router.
- [ ] Route swap/maker through `@kaleidorg/wdk-protocol-swap-kaleidoswap`.
- **Exit:** any destination string resolves to the right protocol+route automatically.

### Phase 5 — Lite/Advanced + unified QR — ~2–3 wk
- [ ] `disclosureLevel` in engine (default at creation, reversible in settings).
- [ ] Lite UI hides networks (BTC / USD=Liquid USDt / assets); advanced reveals selectors.
- [ ] Unified QR: standards-compliant BIP21 base + Ark/Spark extra params; define on-chain
      fallback + invoice refresh. Build on extension's `bip21.ts` + `BtcUnifiedReceive`.
- [ ] Unified onboarding (lite = create→backup→done).
- **Exit:** lite wallet receives via one QR and sends to an LN invoice with zero network names shown.

### Phase 6 — Extension migration (gated by Spike B) — ~3–4 wk
- [ ] Bind `rate-extension` Zustand as a view-model over the engine.
- [ ] `ChromeStorageProvider` implements `IStorageProvider`.
- [ ] Migrate protocol-by-protocol; delete `src/protocols/` duplicate.
- **Exit:** both apps share `@kaleidorg/wallet-protocols` + the WDK modules.

### Phase 7 — Consolidate & harden — ~1–2 wk
- [ ] Remove native fallbacks where WDK proved stable; align derivation paths (wallet portable RN↔ext).
- [ ] Delete deprecated `WalletManager.ts` / `RGBApiService.ts` (rate).
- [ ] Document contract as reviewed API; enforce additive-only + capabilities-not-methods in CI.

---

## 5. Critical path

```
Phase 0 (gate) → 1 → 2 (Spark proves pattern) ─┬─ 3 (Arkade ∥ Rln ∥ Liquid)
                                               ├─ 4 router + swap
                                               └─ 5 lite/advanced + QR → 6 extension → 7 cleanup
```

First demonstrable value: end of Phase 2 (~4–5 wk). Both apps migrated: ~14–20 wk.

---

## 6. Immediate next actions (Phase 0/1 kickoff)
1. Spark + RLN `default`-export Node smoke test (validate non-Bare load). ← starting now
2. Capability manifest + `SparkWdkAdapter` skeleton in `wallet-protocols`.
3. MV3 service-worker spike (Spike B) — schedule, it's the gate for the extension half.
