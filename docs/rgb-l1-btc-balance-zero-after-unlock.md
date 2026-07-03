# RGB-L1 (WASM): BTC on-chain balance reads 0 after unlock

**Status:** root cause confirmed; durable fix is blocked on a `@utexo/rgb-lib-wasm`
publish (see "Fix" below). RGB *asset* balances are unaffected.

## Symptom

After locking and unlocking the wallet (or any service-worker teardown +
`WasmWallet.create()` restore), the **BTC on-chain** balance for an RGB-L1
account shows **0** even though the wallet holds confirmed on-chain BTC. RGB
asset balances restore correctly.

## Root cause

BTC and RGB assets are read from two different stores, and only one is durably
restored on beta.2:

| Balance | Backing store | Restores on unlock? |
| --- | --- | --- |
| RGB assets | rgb-lib SQLite DB (in IndexedDB) | yes |
| BTC on-chain | BDK wallet chain/UTXO state | not reliably |

Confirmed against `UTEXO-Protocol/rgb-lib` (`src/wallet/{offline,online,core}.rs`)
and the wasm bindings (`bindings/wasm/src/lib.rs`):

1. **`getBtcBalance()` never syncs.** The wasm binding is
   `get_btc_balance(None, true)` — `online = None`, `skip_sync = true`. It reads
   the BDK wallet's cached balance only (`get_btc_balance_for_keychain` →
   `bdk_wallet.balance(...)`). Compare native rgb-lib, where
   `get_btc_balance(online, skip_sync=false)` syncs **both** keychains (External
   = colored, Internal = vanilla) before reading.
2. **`sync()` is incremental only.** It calls `sync_db_txos(false)` →
   `start_sync_with_revealed_spks_at`, which re-queries *already-revealed* SPKs.
   If the restored BDK changeset is thin (no revealed SPKs), the incremental
   sync queries nothing and the BTC balance stays 0. `listUnspentsVanilla` calls
   the same `sync_db_txos(false)`, so it adds nothing. **No full-scan is exposed
   in beta.2.**
3. **No `flush()` in beta.2.** `@utexo/rgb-lib-wasm@1.0.0-beta.2` (the installed
   version) has no `flush()`, so the BDK changeset is not guaranteed to commit
   to IndexedDB before the MV3 service worker is killed. On restore, BDK comes
   back thin → incremental sync can't rediscover the UTXOs → BTC = 0. The RGB
   SQLite DB persists through its own path, which is why assets survive.

Net: assets are DB-backed (survive); BTC is BDK-backed and BDK state is not
durably persisted on beta.2.

Note: the host already calls `refreshBalances()` before `GET_ONCHAIN_BALANCE`
(`rate-extension/src/background/assets.ts`), so this is **not** a read-before-sync
timing bug — the incremental sync genuinely cannot recover a thin restored state.

## Why we can't fix it by bumping the dependency

No published wasm version is suitable:

- `1.0.0-beta.2` (`latest`, installed): no `flush`.
- `1.0.9-test` (`test` tag): still no `flush`, `get_btc_balance()` still doesn't
  sync, **and** renames the whole API to snake_case (`get_btc_balance`,
  `create_utxos_begin`, …) — breaks every call `RgbLibWasmAdapter` makes.
- rgb-lib-wasm **`dev` branch**: has `flush()` and keeps the camelCase js_names —
  but is **not published to npm**.

## Fix

1. **Publish `@utexo/rgb-lib-wasm` from `dev`** (has `flush()`, camelCase API),
   e.g. as a new `beta`.
2. In `rate-extension`: bump the dep and **re-vendor** the new
   `rgb_lib_wasm_bindings_bg.wasm` into `public/` (loaded via
   `chrome.runtime.getURL` in `src/protocols/rgb-l1/wasm-loader.ts`).
3. The `flush()` calls already present in `RgbLibWasmAdapter` (after
   `refresh`/`receive`/`createUtxos`/`sendAsset`/`sendBtcOnchain`) then become
   active → BDK state durably persists → BTC balance survives unlock. They are
   version-guarded, so they remain a safe no-op until the bump.
4. **Optional belt-and-suspenders:** if the published build also exposes a
   `full_scan`, add a one-time full scan on `connect()` so a thin restored state
   is rebuilt from the indexer even without prior persistence. (`getBtcBalance()`
   still never syncs on its own, so a sync/full-scan must precede the read — the
   host's pre-read `refreshBalances()` already covers the read path.)

## References

- `RgbLibWasmAdapter.ts` — `getBtcBalance`/`detailedBtcBalance`,
  `refreshBalances`, and the guarded `flushState()`.
- rgb-lib: `get_btc_balance_impl` (syncs both keychains), `sync_if_requested`,
  `sync_db_txos` (`start_sync_with_revealed_spks_at`), `get_btc_balance_for_keychain`.
- wasm bindings: `get_btc_balance` → `get_btc_balance(None, true)`.
